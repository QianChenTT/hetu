import { readFileSync } from 'node:fs'
import type { Capability } from '../../api/capabilities.ts'
import type { Caller, Refusal, RefusalCode } from '../../api/envelope.ts'
import { type FloorConstant, floorConstants } from '../../api/floor.ts'
import { dependencyReason } from '../../api/lifecycle.ts'
import { API_VERSION, folderManifest, installManifest } from '../../api/manifest.ts'
import type { PluginState, SlotState } from '../../api/slots.ts'
import { VERSION } from '../../api/version.ts'
import { Carrier } from '../../backend/carrier/carrier.ts'
import type { HumanLimits, Loader, PluginInfo } from '../../backend/carrier/seams.ts'
import type { Field } from '../../lib/event-log.ts'
import { parseStrict } from '../../lib/hashed-file.ts'
import { type Plugin, run } from '../plugin.ts'
import type { Transport } from '../transport.ts'
import { type FakeMode, holds, ModeGate } from './gate.ts'
import { MemoryStorage, MemoryLuoshu } from './providers.ts'

export { holds }
export type { FakeMode }

export type FakeState = { state: 'ready' } | { state: 'waiting', reason: string } | { state: 'crashed', reason: 'start-timeout' }
export type FakeReply = { ok: true, result: unknown } | { ok: false, refusal: Refusal }

// manifest is the plugin's hetu-plugin.json as an object or a path to it. notes is the luoshu at start
// latencyMs is how long the luoshu, storage and cache take to answer each call, so a plugin meets a save or a read that
// takes time. limits are the human's values for all, read each time, so a test may change them while the plugin runs
export type FakeCoreOptions = {
  manifest: unknown, mode?: FakeMode, notes?: Record<string, string>, readyMs?: number, latencyMs?: number,
  limits?: Partial<Record<FloorConstant, number>>,
}

type Manifest = {
  id: string
  entries: Record<string, unknown>
  requires?: string[]
  provides?: { actions?: Record<string, { from?: string[] }>, topics?: string[] }
  capabilities?: Capability[]
}

// The plugins the fake core runs itself, each a host plugin serving its namespace
const providers = { luoshu: ['changed', 'outside'], storage: [] as string[] } as const
const TESTER = 'tester'

// A manifest with a host or page entry is an install plugin's, checked as one
function manifestOf(input: unknown): Manifest {
  if (typeof input === 'string') {
    const bytes = readFileSync(input)
    const install = /"(host|page)"\s*:/.test(bytes.toString('utf8'))
    return parseStrict(bytes, install ? installManifest : folderManifest) as Manifest
  }
  const entries = (input as { entries?: Record<string, unknown> } | null)?.entries ?? {}
  const install = 'host' in entries || 'page' in entries
  return (install ? installManifest : folderManifest).parse(input) as Manifest
}

// A way in for a caller the fake core plays, with its replies matched by id
class Way {
  private next = 1
  private readonly waiting = new Map<number, (reply: Record<string, unknown>) => void>()
  private readonly post: (message: unknown) => void

  constructor(carrier: Carrier, caller: Caller) {
    const handle = carrier.handle(caller, message => {
      const { kind, id } = message as { kind?: unknown, id?: unknown }
      if (kind !== 'reply' || typeof id !== 'number') return
      this.waiting.get(id)?.(message as Record<string, unknown>)
      this.waiting.delete(id)
    })
    this.post = handle.post
  }

  ask(action: string, args: unknown, ms: number): Promise<FakeReply> {
    const id = this.next++
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolve({ ok: false, refusal: { code: 'timeout', action } })
      }, ms)
      this.waiting.set(id, reply => {
        clearTimeout(timer)
        resolve(reply.ok === true ? { ok: true, result: reply.result } : { ok: false, refusal: reply.refusal as Refusal })
      })
      this.post({ v: VERSION, kind: 'call', id, action, args })
    })
  }
}

// What the carrier asks of the loader, for one plugin under test and the plugins the fake core plays
class FakeLoader implements Loader {
  readonly infos = new Map<string, PluginInfo>()
  private readonly gateSlot: SlotState
  private readonly all: Partial<Record<FloorConstant, number>>
  private readonly listeners = new Set<(caller: Caller, kind: string) => void>()

  constructor(gateSlot: SlotState, all: Partial<Record<FloorConstant, number>>) {
    this.gateSlot = gateSlot
    this.all = all
  }

  // The log, capabilities and watchdog slots read off, as with the human's switch, so calls pass unlogged
  slot(id: string): SlotState {
    if (id === 'gate') return this.gateSlot
    return id === 'log' || id === 'capabilities' || id === 'watchdog' ? 'off' : 'absent'
  }

  view(): number {
    return 1
  }

  plugin(id: string): PluginInfo | null {
    return this.infos.get(id) ?? null
  }

  limits(): HumanLimits {
    return { all: { ...this.all }, plugins: {} }
  }

  recordNothing(): boolean {
    return false
  }

  crashed(caller: Caller, reason: 'closed' | 'flood'): void {
    for (const listener of [...this.listeners]) listener(caller, reason)
  }

  heard(caller: Caller, kind: 'ready' | 'pong' | 'stopped'): void {
    for (const listener of [...this.listeners]) listener(caller, kind)
  }

  // The fake core's log slot reads off and never stalls
  fail(): void {}

  // Resolves true once caller sends kind, false after ms
  waitFor(caller: Caller, kind: string, ms: number): Promise<boolean> {
    return new Promise(resolve => {
      const done = (value: boolean) => {
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(value)
      }
      const listener = (from: Caller, heard: string) => {
        if (heard === kind && sameCaller(from, caller)) done(true)
      }
      const timer = setTimeout(() => done(false), ms)
      this.listeners.add(listener)
    })
  }
}

function sameCaller(one: Caller, two: Caller): boolean {
  return one.kind === 'plugin' && two.kind === 'plugin' && one.id === two.id && one.half === two.half && one.incarnation === two.incarnation
}

// A plugin's way on an in-process handle. What arrives before listen waits for it
function transportOf(carrier: Carrier, caller: Caller): Transport {
  const held: unknown[] = []
  let listener: ((message: unknown) => void) | null = null
  const handle = carrier.handle(caller, message => {
    if (listener === null) held.push(message)
    else listener(message)
  })
  return {
    post: message => handle.post(message),
    listen: next => {
      listener = next
      for (const message of held.splice(0)) next(message)
    },
  }
}

// A core for a plugin's tests: the real carrier with its eleven steps, a gate as the mode says, the luoshu, storage and
// cache in memory and test callers with the grants each test names. One plugin runs on it at a time
export class FakeCore {
  readonly mode: FakeMode
  readonly floor: { event: string, fields: Record<string, Field> }[] = []
  readonly luoshu: {
    write(path: string, text: string, options?: { outside?: boolean }): Promise<void>
    remove(path: string, options?: { outside?: boolean }): Promise<void>
    read(path: string): string | undefined
    // The next luoshu call a plugin makes answers this code, as a luoshu that is busy, down or starting would
    refuseNext(code: RefusalCode): void
    // The most luoshu calls in flight at once since a test last asked
    busiest(): number
  }
  // The human's limits for all, which the carrier reads on each use
  readonly limits: Partial<Record<FloorConstant, number>>

  private readonly manifest: Manifest
  private readonly half: 'worker' | 'host'
  private readonly loader: FakeLoader
  private readonly gate: ModeGate
  private readonly carrier: Carrier
  private readonly memory: MemoryLuoshu
  private readonly storage: MemoryStorage
  private readonly luoshuWay: Way
  private readonly testers = new Map<string, Way>()
  private readonly readyMs: number
  private readonly missing: Set<string>
  private incarnation = 0
  private lastStop: string | null = null
  private waiting: Plugin | null = null
  private live: Caller | null = null

  constructor(options: FakeCoreOptions) {
    this.manifest = manifestOf(options.manifest)
    this.mode = options.mode ?? 'manifest'
    this.readyMs = options.readyMs ?? floorConstants.readyMs
    this.half = 'host' in this.manifest.entries ? 'host' : 'worker'
    this.limits = { ...options.limits }
    this.loader = new FakeLoader(this.mode === 'gate-failed' ? 'failed' : 'on', this.limits)
    this.gate = new ModeGate(this.manifest.id, this.mode, this.manifest.capabilities ?? [])
    // A requirement the fake core doesn't run is missing in every mode. dependency-missing takes the rest away too
    const requires = this.manifest.requires ?? []
    this.missing = new Set(requires.filter(id => this.mode === 'dependency-missing' || !(id in providers)))
    for (const [id, topics] of Object.entries(providers)) {
      if (!this.missing.has(id)) this.infos(id, { state: 'ready', place: 'host', incarnation: 1, serves: 'host', actions: {}, topics: [...topics] })
    }
    this.memory = new MemoryLuoshu(path => this.publish('luoshu.changed', path), options.latencyMs ?? 0)
    this.storage = new MemoryStorage(options.latencyMs ?? 0)
    for (const [path, text] of Object.entries(options.notes ?? {})) this.memory.notes.set(path, text)
    this.carrier = new Carrier({
      loader: this.loader,
      gate: () => this.gate,
      guards: () => null,
      providers: id => (id === 'luoshu' ? this.memory : id === 'storage' ? this.storage : null),
      watchdog: () => null,
      log: { append: async (event, fields = {}) => { this.floor.push({ event, fields }) }, healthy: true },
    })
    this.luoshuWay = new Way(this.carrier, { kind: 'plugin', id: 'luoshu', half: 'host', incarnation: 1 })
    this.luoshu = {
      write: async (path, text, options = {}) => {
        this.memory.notes.set(path, text)
        await this.publish(options.outside === true ? 'luoshu.outside' : 'luoshu.changed', path)
      },
      remove: async (path, options = {}) => {
        this.memory.notes.delete(path)
        await this.publish(options.outside === true ? 'luoshu.outside' : 'luoshu.changed', path)
      },
      read: path => this.memory.notes.get(path),
      refuseNext: code => { this.memory.refusals.push(code) },
      busiest: () => this.memory.busiest(),
    }
  }

  // Runs the plugin as the loader would: init with its deps and lastStop, then ready within readyMs. A missing
  // requirement holds it waiting with its reason, as the loader does. Its start then never runs
  async start(plugin: Plugin): Promise<FakeState> {
    if (this.live !== null || this.waiting !== null) throw new Error('a plugin is already running on this core')
    const absent = (this.manifest.requires ?? []).find(id => this.missing.has(id))
    if (absent !== undefined) {
      this.waiting = plugin
      this.lastStop = dependencyReason(absent, 'absent')
      return { state: 'waiting', reason: this.lastStop }
    }
    return this.launch(plugin)
  }

  // Brings back every missing requirement and starts a waiting plugin, which reads why it waited in lastStop
  async restore(): Promise<FakeState> {
    for (const id of this.missing) {
      if (id in providers) this.infos(id, { state: 'ready', place: 'host', incarnation: 1, serves: 'host', actions: {}, topics: [...providers[id as keyof typeof providers]] })
    }
    this.missing.clear()
    const plugin = this.waiting
    if (plugin === null) throw new Error('no plugin is waiting')
    this.waiting = null
    return this.launch(plugin)
  }

  // Stops the plugin with the floor's grace, as the human's switch would
  async stop(): Promise<void> {
    const caller = this.live
    if (caller === null) return
    this.setState('stopping')
    const stopped = this.loader.waitFor(caller, 'stopped', floorConstants.stopGraceMs)
    this.carrier.send(caller, { v: VERSION, kind: 'stop', graceMs: floorConstants.stopGraceMs })
    await stopped
    this.carrier.end(caller, 'stopped')
    this.setState('stopped')
    this.live = null
    this.lastStop = 'human'
  }

  // A call from another plugin. as names it, tester by default, granted plugin.call on the plugin and luoshu.read
  // on ** unless grants names its grants
  call(action: string, args: unknown = {}, options: { as?: string, grants?: Capability[] } = {}): Promise<FakeReply> {
    const id = options.as ?? TESTER
    if (id === this.manifest.id || id in providers) throw new Error(`${id} is a plugin the fake core runs itself`)
    let way = this.testers.get(id)
    if (way === undefined) {
      this.infos(id, { state: 'ready', place: 'sandboxed', incarnation: 1, serves: 'worker', actions: {}, topics: [] })
      way = new Way(this.carrier, { kind: 'plugin', id, half: 'worker', incarnation: 1 })
      this.testers.set(id, way)
    }
    if (options.grants !== undefined || !this.gate.grants.has(id)) {
      this.gate.grants.set(id, options.grants ?? [
        { type: 'plugin.call', targets: [this.manifest.id] },
        { type: 'luoshu.read', paths: ['**'] },
      ])
    }
    return way.ask(action, args, floorConstants.callDeadlineMs + 1000)
  }

  // What the plugin under test stored under key in its storage or cache, undefined for nothing
  stored(kind: 'storage' | 'cache', key: string): unknown {
    return this.storage.read(kind, this.manifest.id, key)
  }

  async close(): Promise<void> {
    this.carrier.close()
    await this.carrier.flushFloor()
  }

  private async launch(plugin: Plugin): Promise<FakeState> {
    const incarnation = ++this.incarnation
    const caller: Caller = { kind: 'plugin', id: this.manifest.id, half: this.half, incarnation }
    this.infos(this.manifest.id, {
      state: 'starting',
      place: this.half === 'host' ? 'host' : 'sandboxed',
      incarnation,
      serves: this.half,
      actions: this.manifest.provides?.actions ?? {},
      topics: this.manifest.provides?.topics ?? [],
    })
    const ready = this.loader.waitFor(caller, 'ready', this.readyMs)
    run(plugin, transportOf(this.carrier, caller))
    this.carrier.send(caller, {
      v: VERSION, kind: 'init', id: this.manifest.id, incarnation, api: API_VERSION, deps: this.deps(), lastStop: this.lastStop, previousVersion: null,
    })
    if (!(await ready)) {
      this.setState('crashed')
      this.carrier.end(caller, 'crashed')
      this.lastStop = 'start-timeout'
      return { state: 'crashed', reason: 'start-timeout' }
    }
    this.setState('ready')
    this.live = caller
    return { state: 'ready' }
  }

  // Its requires and plugin.call targets: ready when the fake core runs it, else unavailable
  private deps(): Record<string, 'ready' | 'unavailable'> {
    const targets = (this.manifest.capabilities ?? []).flatMap(item => (item.type === 'plugin.call' ? item.targets : []))
    const deps: Record<string, 'ready' | 'unavailable'> = {}
    for (const id of [...(this.manifest.requires ?? []), ...targets]) deps[id] = this.loader.infos.get(id)?.state === 'ready' ? 'ready' : 'unavailable'
    return deps
  }

  private infos(id: string, info: PluginInfo): void {
    this.loader.infos.set(id, info)
  }

  private setState(state: PluginState): void {
    const info = this.loader.infos.get(this.manifest.id)
    if (info !== undefined) this.loader.infos.set(this.manifest.id, { ...info, state })
  }

  private async publish(topic: 'luoshu.changed' | 'luoshu.outside', path: string): Promise<void> {
    await this.luoshuWay.ask('events.publish', { topic, path }, floorConstants.callDeadlineMs)
  }
}

export function fakeCore(options: FakeCoreOptions): FakeCore {
  return new FakeCore(options)
}
