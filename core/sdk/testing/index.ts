import { readFileSync } from 'node:fs'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import type { Capability } from '../../api/capabilities.ts'
import { grantKeyOf, type Caller, type Refusal, type RefusalCode } from '../../api/envelope.ts'
import { type LimitName, defaultLimits } from '../../api/limits.ts'
import { utilityIds } from '../../api/ids.ts'
import { dependencyReason, type DepState } from '../../api/lifecycle.ts'
import { API_VERSION, folderManifest, installManifest, supportsApi, type ViewSpec } from '../../api/manifest.ts'
import type { Call, PluginState, PolicyJobState } from '../../api/policy-jobs.ts'
import { VERSION } from '../../api/version.ts'
import { Router } from '../../backend/router/router.ts'
import { Limits } from '../../backend/router/limits.ts'
import { createFloodControl } from '../../backend/flood-control/flood-control.ts'
import { createGateActions } from '../../backend/policy/gate/actions.ts'
import type { Recording } from '../../backend/recording/header.ts'
import { createRecording } from '../../backend/recording/recording.ts'
import type { HumanLimits, PluginInfo, PluginTable } from '../../api/policy-jobs.ts'
import type { Field } from '../../lib/event-log.ts'
import { parseStrict } from '../../lib/hashed-file.ts'
import { type Plugin, run } from '../plugin.ts'
import type { Transport } from '../transport.ts'
import { FakeDrawer } from './drawer.ts'
import { type FakeMode, holds, ModeGate, pairKey } from './gate.ts'
import { MemoryHistory, MemoryStorage, MemoryLuoshu } from './providers.ts'

export { FakeDrawer, holds }
export type { FakeMode }

export type FakeState = { state: 'ready' } | { state: 'waiting', reason: string } | { state: 'crashed', reason: 'start-timeout' }
export type FakeReply = { ok: true, result: unknown } | { ok: false, refusal: Refusal }

// A call the router delivered to a stand-in, onBehalf only when the caller named one
export type Delivered = { action: string, args: unknown, caller: Caller, onBehalf?: string }
// What deps tells the plugin under test of a stand-in
export type StandInState = DepState
// A plugin the fake core plays for the plugin under test: its actions with their from lists, which the real router
// enforces, and handle, which answers each call delivered. What handle returns is the result and a throw of { code }
// is the refusal. Without handle every call answers null. state is ready unless named
export type StandInOptions = {
  actions: Record<string, { from?: string[] }>
  handle?: (call: Delivered) => unknown
  state?: StandInState
}
// Each call delivered to the stand-in, oldest first
export type StandIn = { readonly id: string, readonly delivered: readonly Delivered[] }
// A core action that reached the part the core serves, which the fake core plays for core.bindFailed alone
export type CoreCall = { action: string, args: unknown, caller: Caller }

// manifest is the plugin's hetu-plugin.json as an object or a path to it. notes is the luoshu at start
// latencyMs is how long the luoshu, storage, cache and history take to answer each call, so a plugin meets a save or a
// read that takes time. limits are the human's values for all, read each time, so a test may change them while the
// plugin runs
// drawer is an editor page's drawer in memory, which the plugin's ctx.editor and ctx.ui reach once it runs
export type FakeCoreOptions = {
  manifest: unknown, mode?: FakeMode, notes?: Record<string, string>, readyMs?: number, latencyMs?: number,
  limits?: Partial<Record<LimitName, number>>, drawer?: FakeDrawer,
}

type Manifest = {
  id: string
  api: string
  views?: Record<string, ViewSpec>
  entries: Record<string, unknown>
  requires?: string[]
  provides?: { actions?: Record<string, { from?: string[] }>, topics?: string[] }
  capabilities?: Capability[]
}

// The plugins the fake core runs itself, each a host plugin serving its namespace
const providers = { luoshu: ['changed', 'outside'], storage: [] as string[], history: [] as string[] } as const
const TESTER = 'tester'

// A manifest with a host entry is a core plugin's, checked as one. An api range this core leaves out throws, as the
// plugins manager refuses it with api
function manifestOf(input: unknown): Manifest {
  let parsed: Manifest
  if (typeof input === 'string') {
    const bytes = readFileSync(input)
    const install = /"host"\s*:/.test(bytes.toString('utf8'))
    parsed = parseStrict(bytes, install ? installManifest : folderManifest) as Manifest
  } else {
    const entries = (input as { entries?: Record<string, unknown> } | null)?.entries ?? {}
    const install = 'host' in entries
    parsed = (install ? installManifest : folderManifest).parse(input) as Manifest
  }
  if (!supportsApi(parsed.api, (parsed.capabilities ?? []).map(granted => granted.type))) {
    throw new Error(`api ${parsed.api} leaves out this core's API, version ${API_VERSION}`)
  }
  return parsed
}

// A way in for a caller the fake core plays, with its replies matched by id
class Way {
  private next = 1
  private readonly waiting = new Map<number, (reply: Record<string, unknown>) => void>()
  private readonly post: (message: unknown) => void

  constructor(router: Router, caller: Caller) {
    const handle = router.handle(caller, message => {
      const { kind, id } = message as { kind?: unknown, id?: unknown }
      if (kind !== 'reply' || typeof id !== 'number') return
      this.waiting.get(id)?.(message as Record<string, unknown>)
      this.waiting.delete(id)
    })
    this.post = handle.post
  }

  ask(action: string, args: unknown, ms: number, onBehalf?: string): Promise<FakeReply> {
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
      this.post({ v: VERSION, kind: 'call', id, action, args, ...(onBehalf === undefined ? {} : { onBehalf }) })
    })
  }
}

// The plugin table the router reads and what the ways in heard, for one plugin under test and the plugins the fake
// core plays
class FakePluginsManager implements PluginTable {
  readonly infos = new Map<string, PluginInfo>()
  private readonly gateState: PolicyJobState
  private readonly all: Partial<Record<LimitName, number>>
  private readonly listeners = new Set<(caller: Caller, kind: string) => void>()

  constructor(gateState: PolicyJobState, all: Partial<Record<LimitName, number>>) {
    this.gateState = gateState
    this.all = all
  }

  // The grant risk classifier policy job and the lock read off, as with the human's switch, so no write here waits on
  // a lock module the fake core doesn't hold
  policyJob(id: string): PolicyJobState {
    if (id === 'gate') return this.gateState
    return id === 'grant-risk-classifier' || id === 'lock' ? 'off' : 'absent'
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

  crashed(caller: Caller, reason: 'closed' | 'flood' | 'malformed'): void {
    for (const listener of [...this.listeners]) listener(caller, reason)
  }

  heard(caller: Caller, kind: 'ready' | 'pong' | 'stopped' | 'alive'): void {
    for (const listener of [...this.listeners]) listener(caller, kind)
  }

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

// A utility half's way: a port registered with the router, as the plugins manager registers the port of a utility process
function portTransportOf(router: Router, caller: Caller, ports: MessagePort[]): Transport {
  const { port1, port2 } = new MessageChannel()
  ports.push(port1, port2)
  router.register(port1, caller)
  return {
    post: message => port2.postMessage(message),
    listen: next => { port2.on('message', next) },
  }
}

// A plugin's way on an in-process handle. What arrives before listen waits for it
function transportOf(router: Router, caller: Caller): Transport {
  const held: unknown[] = []
  let listener: ((message: unknown) => void) | null = null
  const handle = router.handle(caller, message => {
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

// A core for a plugin's tests: the real router with its eleven steps, a gate as the mode says, the luoshu, storage,
// cache and history in memory, test callers with the grants each test names and stand-ins for other plugins. One plugin
// runs on it at a time, placed as the plugins manager would place it: mcp-http-handler's host entry in a utility process
// on a port
export class FakeCore {
  readonly mode: FakeMode
  readonly coreRecords: { event: string, fields: Record<string, Field> }[] = []
  // Each core action that reached the part the core serves, oldest first. core.bindFailed ends the plugin under test
  // as failed with its reason and every other answers unavailable
  readonly coreCalls: CoreCall[] = []
  readonly luoshu: {
    write(path: string, text: string, options?: { outside?: boolean }): Promise<void>
    remove(path: string, options?: { outside?: boolean }): Promise<void>
    read(path: string): string | undefined
    // The next luoshu call a plugin makes answers this code, as a luoshu that is busy, down or starting would
    refuseNext(code: RefusalCode): void
    // The most luoshu calls in flight at once since a test last asked
    busiest(): number
  }
  // The human's limits for all, which the router reads on each use
  readonly limits: Partial<Record<LimitName, number>>

  private readonly manifest: Manifest
  private readonly half: 'worker' | 'host'
  private readonly pluginsManager: FakePluginsManager
  private readonly gate: ModeGate
  private readonly router: Router
  private readonly recording: Recording
  private readonly memory: MemoryLuoshu
  private readonly storage: MemoryStorage
  private readonly history: MemoryHistory
  private readonly luoshuWay: Way
  private readonly testers = new Map<string, Way>()
  private readonly readyMs: number
  private readonly drawer: FakeDrawer | null
  private readonly missing: Set<string>
  private readonly standIns = new Map<string, { state: StandInState, actions: Record<string, { from?: string[] }> }>()
  private readonly ports: MessagePort[] = []
  private incarnation = 0
  private lastStop: string | null = null
  private reason: string | null = null
  private waiting: Plugin | null = null
  private live: Caller | null = null

  constructor(options: FakeCoreOptions) {
    this.manifest = manifestOf(options.manifest)
    this.mode = options.mode ?? 'manifest'
    this.readyMs = options.readyMs ?? defaultLimits.readyMs
    this.drawer = options.drawer ?? null
    this.half = 'host' in this.manifest.entries ? 'host' : 'worker'
    this.limits = { ...options.limits }
    this.pluginsManager = new FakePluginsManager(this.mode === 'gate-failed' ? 'failed' : 'on', this.limits)
    this.gate = new ModeGate(this.manifest.id, this.mode, this.manifest.capabilities ?? [])
    // A requirement the fake core doesn't run is missing in every mode. dependency-missing takes the rest away too
    const requires = this.manifest.requires ?? []
    this.missing = new Set(requires.filter(id => this.mode === 'dependency-missing' || !(id in providers)))
    for (const [id, topics] of Object.entries(providers)) {
      if (!this.missing.has(id)) this.infos(id, { state: 'ready', place: 'host', incarnation: 1, serves: 'host', actions: {}, topics: [...topics] })
    }
    this.memory = new MemoryLuoshu(path => this.publish('luoshu.changed', path), options.latencyMs ?? 0)
    this.storage = new MemoryStorage(options.latencyMs ?? 0)
    this.history = new MemoryHistory(this.memory.notes, options.latencyMs ?? 0)
    for (const [path, text] of Object.entries(options.notes ?? {})) this.memory.notes.set(path, text)
    // Flood control counts by the limits the fake core was given, as the core's does by the human's
    const limits = new Limits(() => this.pluginsManager.limits())
    const floodControl = createFloodControl({ limit: (plugin, name) => limits.of(plugin, name), clock: () => performance.now() })
    // Core records are kept and the call records are taken and dropped, so calls pass unlogged
    this.recording = createRecording({
      log: {
        append: async (event, fields = {}) => { this.coreRecords.push({ event, fields }) },
        appendMany: async () => {},
        history: async () => [],
        verify: async () => ({ ok: true }),
        healthy: true,
      },
      off: () => false,
      limit: name => limits.of(null, name),
      hash: () => '',
    })
    // The gate's own actions as the core makes them, over the fake core's gate
    const gateActions = createGateActions({
      gate: () => this.gate,
      table: () => this.pluginsManager,
      stopping: () => this.router.shutting(),
      limit: plugin => limits.of(plugin, 'filterMsPerSecond'),
      clock: () => performance.now(),
      fault: () => {},
    })
    this.router = new Router({
      gateTime: gateActions.time,
      floodControl: () => floodControl,
      gate: () => this.gate,
      guards: () => null,
      providers: id => (id === 'luoshu' ? this.memory : id === 'storage' ? this.storage : id === 'history' ? this.history : null),
      recording: this.recording,
    })
    this.router.read(this.pluginsManager)
    this.router.serve('plugins-manager', call => this.served(call))
    this.router.serve('recording', call => this.recording.serve(call))
    this.router.serve('gate', gateActions.serve)
    this.router.onWayClosed((caller, reason) => this.pluginsManager.crashed(caller, reason))
    this.router.onHeard((caller, kind) => this.pluginsManager.heard(caller, kind))
    this.luoshuWay = new Way(this.router, { kind: 'plugin', id: 'luoshu', half: 'host', incarnation: 1 })
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

  // Runs the plugin as the plugins manager would: init with its deps and lastStop, then ready within readyMs. A missing
  // requirement holds it waiting with its reason, as the plugins manager does. Its start then never runs
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

  // Stops the plugin with the fixed grace, as the human's switch would
  async stop(): Promise<void> {
    const caller = this.live
    if (caller === null) return
    this.markState('stopping')
    const stopped = this.pluginsManager.waitFor(caller, 'stopped', defaultLimits.stopGraceMs)
    this.router.send(caller, { v: VERSION, kind: 'stop', graceMs: defaultLimits.stopGraceMs })
    await stopped
    this.router.end(caller, 'stopped')
    this.markState('stopped')
    this.live = null
    this.lastStop = 'human'
  }

  // A call from another plugin. as names it, tester by default, granted plugin.call on the plugin and luoshu.read
  // on ** unless grants names its grants. onBehalf makes it the root of a chain for that pair, whose calls under it
  // need the pair's grants too: none until pairGrants names them for the field up to its first #
  call(action: string, args: unknown = {}, options: { as?: string, grants?: Capability[], onBehalf?: string, pairGrants?: Capability[] } = {}): Promise<FakeReply> {
    const id = options.as ?? TESTER
    if (id === this.manifest.id || id in providers) throw new Error(`${id} is a plugin the fake core runs itself`)
    let way = this.testers.get(id)
    if (way === undefined) {
      this.infos(id, { state: 'ready', place: 'sandboxed', incarnation: 1, serves: 'worker', actions: {}, topics: [] })
      way = new Way(this.router, { kind: 'plugin', id, half: 'worker', incarnation: 1 })
      this.testers.set(id, way)
    }
    if (options.grants !== undefined || !this.gate.grants.has(id)) {
      this.gate.grants.set(id, options.grants ?? [
        { type: 'plugin.call', targets: [this.manifest.id] },
        { type: 'luoshu.read', paths: ['**'] },
      ])
    }
    if (options.pairGrants !== undefined) {
      if (options.onBehalf === undefined) throw new Error('pairGrants needs onBehalf, which names the pair')
      this.gate.pairs.set(pairKey({ plugin: id, field: grantKeyOf(options.onBehalf) }), options.pairGrants)
    }
    return way.ask(action, args, defaultLimits.callDeadlineMs + 1000, options.onBehalf)
  }

  // Plays another plugin on its worker half: the plugin under test calls it through the real router, which checks
  // each action's from list. A requirement it stands in for is no longer missing
  standIn(id: string, options: StandInOptions): StandIn {
    if (id === this.manifest.id || id in providers || this.testers.has(id) || this.standIns.has(id)) {
      throw new Error(`${id} is a plugin the fake core runs already`)
    }
    const delivered: Delivered[] = []
    const caller: Caller = { kind: 'plugin', id, half: 'worker', incarnation: 1 }
    const handle = this.router.handle(caller, message => {
      const { kind, callId, action, args, onBehalf } = message as Record<string, unknown>
      if (kind !== 'call' || typeof callId !== 'string' || typeof action !== 'string') return
      const call: Delivered = { action, args, caller: (message as { caller: Caller }).caller, ...(typeof onBehalf === 'string' ? { onBehalf } : {}) }
      delivered.push(call)
      void (async () => {
        try {
          const result = options.handle === undefined ? null : await options.handle(call)
          handle.post({ v: VERSION, kind: 'reply', callId, ok: true, result })
        } catch (err) {
          const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : 'failed'
          handle.post({ v: VERSION, kind: 'reply', callId, ok: false, refusal: { code, action } })
        }
      })()
    })
    this.standIns.set(id, { state: options.state ?? 'ready', actions: options.actions })
    this.missing.delete(id)
    this.placeStandIn(id)
    return { id, delivered }
  }

  // Sets a stand-in's state and tells the plugin under test with deps, as the plugins manager does on every change
  setState(id: string, state: StandInState): void {
    const standIn = this.standIns.get(id)
    if (standIn === undefined) throw new Error(`${id} is no stand-in`)
    standIn.state = state
    this.placeStandIn(id)
    if (this.live !== null) this.router.send(this.live, { v: VERSION, kind: 'deps', deps: this.deps() })
  }

  // The plugin under test as the plugin list would show it: its state and why, null while it runs
  status(): { state: PluginState | null, reason: string | null } {
    return { state: this.pluginsManager.infos.get(this.manifest.id)?.state ?? null, reason: this.reason }
  }

  // What the plugin under test stored under key in its storage or cache, undefined for nothing
  stored(kind: 'storage' | 'cache', key: string): unknown {
    return this.storage.read(kind, this.manifest.id, key)
  }

  async close(): Promise<void> {
    this.router.close()
    await this.recording.flush()
    for (const port of this.ports.splice(0)) port.close()
  }

  private async launch(plugin: Plugin): Promise<FakeState> {
    const incarnation = ++this.incarnation
    const caller: Caller = { kind: 'plugin', id: this.manifest.id, half: this.half, incarnation }
    const utility = this.half === 'host' && (utilityIds as readonly string[]).includes(this.manifest.id)
    this.reason = null
    this.infos(this.manifest.id, {
      state: 'starting',
      place: utility ? 'utility' : this.half === 'host' ? 'host' : 'sandboxed',
      incarnation,
      serves: this.half,
      actions: this.manifest.provides?.actions ?? {},
      topics: this.manifest.provides?.topics ?? [],
    })
    const ready = this.pluginsManager.waitFor(caller, 'ready', this.readyMs)
    const transport = utility ? portTransportOf(this.router, caller, this.ports) : transportOf(this.router, caller)
    run(plugin, transport, this.drawer === null ? {} : { editor: this.drawer.fresh() })
    this.drawer?.connect(this.manifest.capabilities ?? [], this.manifest.views ?? {})
    this.router.send(caller, {
      v: VERSION, kind: 'init', id: this.manifest.id, incarnation, api: API_VERSION, deps: this.deps(), lastStop: this.lastStop, previousVersion: null,
    })
    if (!(await ready)) {
      this.markState('crashed')
      this.router.end(caller, 'crashed')
      this.lastStop = 'start-timeout'
      return { state: 'crashed', reason: 'start-timeout' }
    }
    this.markState('ready')
    this.live = caller
    return { state: 'ready' }
  }

  // Its requires and plugin.call targets: ready or starting as the fake core runs it or a stand-in's state, else
  // unavailable
  private deps(): Record<string, DepState> {
    const targets = (this.manifest.capabilities ?? []).flatMap(item => (item.type === 'plugin.call' ? item.targets : []))
    const deps: Record<string, DepState> = {}
    for (const id of [...(this.manifest.requires ?? []), ...targets]) {
      const state = this.pluginsManager.infos.get(id)?.state
      deps[id] = state === 'ready' ? 'ready' : state === 'starting' ? 'starting' : 'unavailable'
    }
    return deps
  }

  // A stand-in as the router finds it: a sandboxed plugin answering from its worker, stopped while unavailable
  private placeStandIn(id: string): void {
    const { state, actions } = this.standIns.get(id)!
    this.infos(id, { state: state === 'unavailable' ? 'stopped' : state, place: 'sandboxed', incarnation: 1, serves: 'worker', actions, topics: [] })
  }

  // core.bindFailed from the half that runs ends it as failed with the reason before any answer, as the plugins manager does
  private async served(call: Call): Promise<unknown> {
    // The plugins manager's own core.self and core.refused, the second written as <plugin id>.refused coalesced by reason
    if (call.action === 'core.self') return call.caller
    if (call.action === 'core.refused') {
      const { reason, count } = call.args as { reason: string, count: number }
      if (call.caller.kind === 'plugin') this.recording.coalesced(`${call.caller.id}.refused`, { reason }, undefined, count)
      return null
    }
    this.coreCalls.push({ action: call.action, args: call.args, caller: call.caller })
    const live = this.live
    if (call.action !== 'core.bindFailed') throw { code: 'unavailable' }
    if (live === null || !sameCaller(live, call.caller)) throw { code: 'not-found' }
    const reason = (call.args as { reason: string }).reason
    this.markState('failed')
    this.reason = reason
    this.lastStop = reason
    this.live = null
    this.router.end(live, 'crashed')
    return null
  }

  private infos(id: string, info: PluginInfo): void {
    this.pluginsManager.infos.set(id, info)
  }

  private markState(state: PluginState): void {
    const info = this.pluginsManager.infos.get(this.manifest.id)
    if (info !== undefined) this.pluginsManager.infos.set(this.manifest.id, { ...info, state })
  }

  private async publish(topic: 'luoshu.changed' | 'luoshu.outside', path: string): Promise<void> {
    await this.luoshuWay.ask('events.publish', { topic, path }, defaultLimits.callDeadlineMs)
  }
}

export function fakeCore(options: FakeCoreOptions): FakeCore {
  return new FakeCore(options)
}
