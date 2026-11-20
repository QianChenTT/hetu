import { createHash } from 'node:crypto'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import type { Capability } from '../api/capabilities.ts'
import type { Caller } from '../api/envelope.ts'
import type { LimitName } from '../api/limits.ts'
import { isDotName, scopeMatches } from '../api/scope.ts'
import type {
  Access, Call, Decision, Gate, Guard, GuardCall, HumanLimits, LogSegment, LogVerification, PluginInfo, PluginTable, Prepared, Provider, PolicyJobState,
} from '../api/policy-jobs.ts'
import { windowGrants } from '../api/windows.ts'
import { Router } from '../backend/router/router.ts'
import { Limits } from '../backend/router/limits.ts'
import { createFloodControl } from '../backend/flood-control/flood-control.ts'
import type { CoreLog, Recording } from '../backend/recording/header.ts'
import { createRecording } from '../backend/recording/recording.ts'
import { createGateActions } from '../backend/policy/gate/actions.ts'
import type { Asks, RouterOptions, Served } from '../backend/router/header.ts'

export const worker = (id: string, incarnation = 1): Caller => ({ kind: 'plugin', id, half: 'worker', incarnation })
export const host = (id: string, incarnation = 1): Caller => ({ kind: 'plugin', id, half: 'host', incarnation })
export const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
export const trusted: Caller = { kind: 'window', role: 'trusted', n: 0 }

export type Message = Record<string, unknown>

export const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

// The plugin table the router reads, with what the ways in told it through the router's door
export class FakePluginsManager implements PluginTable {
  policyJobs: Record<string, PolicyJobState> = { gate: 'on', 'grant-risk-classifier': 'on' }
  plugins: Record<string, PluginInfo> = {}
  current = 1
  // Writable here, so a test can set the human's limits
  human: { all: Partial<Record<LimitName, number>>, plugins: Record<string, Partial<Record<LimitName, number>>> } = { all: {}, plugins: {} }
  nothing = false
  // The labels the human revoked, none unless a test names one
  revokedLabels = new Set<string>()
  crashes: { caller: Caller, reason: string }[] = []
  lifecycle: { caller: Caller, kind: string }[] = []

  policyJob(id: string): PolicyJobState {
    return this.policyJobs[id] ?? 'absent'
  }

  view(): number {
    return this.current
  }

  plugin(id: string): PluginInfo | null {
    return this.plugins[id] ?? null
  }

  limits(): HumanLimits {
    return this.human
  }

  revoked(label: string): boolean {
    return this.revokedLabels.has(label)
  }

  crashed(caller: Caller, reason: 'closed' | 'flood' | 'malformed'): void {
    this.crashes.push({ caller, reason })
  }

  heard(caller: Caller, kind: string): void {
    this.lifecycle.push({ caller, kind })
  }

  // A sandboxed plugin answering from its worker
  sandboxed(id: string, actions: PluginInfo['actions'] = {}, state: PluginInfo['state'] = 'ready', incarnation = 1): void {
    this.plugins[id] = { state, place: 'sandboxed', incarnation, serves: 'worker', actions, topics: [] }
  }

  installed(id: string, state: PluginInfo['state'] = 'ready'): void {
    this.plugins[id] = { state, place: 'host', incarnation: 1, serves: 'host', actions: {}, topics: [] }
  }

  // A core plugin whose host half runs in a utility process, on a port as a worker's
  utility(id: string, state: PluginInfo['state'] = 'ready'): void {
    this.plugins[id] = { state, place: 'utility', incarnation: 1, serves: 'host', actions: {}, topics: [] }
  }
}

// Whether grants hold an access, with core/api's own matcher on a volume that keeps case
export function holds(granted: readonly Capability[], access: Pick<Access, 'capability' | 'scope'>): boolean {
  return granted.some(item => {
    if (item.type !== access.capability) return false
    if (item.type === 'luoshu.read' || item.type === 'luoshu.write' || item.type === 'luoshu.list' || item.type === 'ui.edit' || item.type === 'ui.read') {
      const paths = access.scope.paths ?? []
      return paths.every(path => item.paths.some(grant => scopeMatches(grant, path, { foldCase: false })))
    }
    if (item.type === 'plugin.call') return access.scope.target !== undefined && item.targets.includes(access.scope.target)
    if (item.type === 'events.subscribe') return (access.scope.topics ?? []).every(topic => item.topics.includes(topic))
    if (item.type === 'history') {
      const paths = access.scope.paths ?? []
      return item.access === access.scope.access && paths.every(path => item.paths.some(grant => scopeMatches(grant, path, { foldCase: false })))
    }
    if (item.type === 'exec') return item.commands.some(command => JSON.stringify(command) === JSON.stringify(access.scope.command))
    return true
  })
}

// Decides from a grant table by plugin id, windows from core/api's window grants
export class FakeGate implements Gate {
  readonly grants: Record<string, Capability[]> = {}
  readonly asked: Access[] = []
  readonly reads: { caller: Caller, path: string }[] = []
  // Takes over from the grant table when set
  decision: ((access: Access) => unknown) | null = null
  readable: ((caller: Caller, path: string) => unknown) | null = null
  readonly lists: { caller: Caller, path: string }[] = []
  // Answers canList in place of the grant table, a throw included
  listable: ((caller: Caller, path: string) => unknown) | null = null
  private readonly pluginsManager: FakePluginsManager

  constructor(pluginsManager: FakePluginsManager) {
    this.pluginsManager = pluginsManager
  }

  grantsOf(caller: Caller): readonly Capability[] {
    if (caller.kind === 'plugin') return this.grants[caller.id] ?? []
    return caller.kind === 'window' ? windowGrants[caller.role] : []
  }

  decide(access: Access): Decision {
    this.asked.push(access)
    if (this.decision !== null) return this.decision(access) as Decision
    return this.granted(access)
  }

  // The grant table's answer on the current grants snapshot
  granted(access: Access): Decision {
    const view = this.pluginsManager.current
    return holds(this.grantsOf(access.caller), access) ? { allow: true, view } : { allow: false, code: 'not-granted', view }
  }

  canRead(caller: Caller, path: string): boolean {
    this.reads.push({ caller, path })
    if (this.readable !== null) return this.readable(caller, path) as boolean
    return holds(this.grantsOf(caller), { capability: 'luoshu.read', scope: { paths: [path] } })
  }

  canList(caller: Caller, path: string): boolean {
    this.lists.push({ caller, path })
    if (this.listable !== null) return this.listable(caller, path) as boolean
    const granted = this.grantsOf(caller)
    return holds(granted, { capability: 'luoshu.list', scope: { paths: [path] } }) || holds(granted, { capability: 'luoshu.read', scope: { paths: [path] } })
  }

  // The ui items in the plugin's grant table, for the editor window only
  verbs(plugin: string, window: string): string[] {
    if (window !== 'editor') return []
    // A ui item scoped by paths reaches only the notes it names, so it is never a verb held whole
    const whole = (granted: Capability) => granted.type.startsWith('ui.') && !('paths' in granted)
    return [...new Set((this.grants[plugin] ?? []).filter(whole).map(granted => granted.type))]
  }

  stateChanged(): void {}
}

export class FakeGuard implements Guard {
  readonly calls: GuardCall[] = []
  answer: (call: GuardCall) => unknown = () => 'allow'

  check(call: GuardCall): 'allow' | 'deny' {
    this.calls.push(call)
    return this.answer(call) as 'allow' | 'deny'
  }
}

// A luoshu that resolves 8.3 short names the way Windows does, so GIT~1/config prepares to .git/config. It refuses
// nothing itself, which leaves the judging to decide
export class FakeLuoshu implements Provider {
  readonly files = new Map<string, string>()
  readonly prepared: Call[] = []
  readonly performed: { call: Call, prepared: Prepared }[] = []
  readonly released: string[] = []
  readonly short = new Map([['GIT~1', '.git']])
  // Holds prepare or perform open until the test lets go
  hold: { prepare?: Promise<unknown>, perform?: Promise<unknown> } = {}
  perform_: ((call: Call, prepared: Prepared) => unknown) | null = null

  async prepare(call: Call): Promise<Prepared> {
    this.prepared.push(call)
    await this.hold.prepare
    if (call.action === 'luoshu.list') return { scope: {} }
    const resolve = (path: string) => path.split('/').map(name => this.short.get(name) ?? name).join('/')
    // A move's two ends, in the order the router built its raw scope
    if (call.action === 'luoshu.move') {
      const { from, to } = call.args as { from: string, to: string }
      return { scope: { paths: [resolve(from), resolve(to)] } }
    }
    const { path, baseVersion } = call.args as { path: string, baseVersion?: string }
    const scope = { paths: [resolve(path)] }
    return baseVersion === undefined ? { scope } : { scope, baseVersion }
  }

  async perform(call: Call, prepared: Prepared): Promise<unknown> {
    this.performed.push({ call, prepared })
    await this.hold.perform
    if (this.perform_ !== null) return this.perform_(call, prepared)
    // Every name, unfiltered, as the luoshu lists them
    // Every name the router's canList lets through, as the luoshu lists them, its walk passing dot names by unasked
    if (call.action === 'luoshu.list') {
      const names = [...this.files.keys()].sort().filter(name => !name.split('/').some(isDotName))
      return { paths: names.filter(name => call.canList?.(name) === true), next: null }
    }
    const path = prepared.scope.paths![0]
    if (call.action === 'luoshu.move') {
      const to = prepared.scope.paths![1]
      if (!this.files.has(path)) throw { code: 'not-found' }
      this.files.set(to, this.files.get(path)!)
      this.files.delete(path)
      return null
    }
    if (call.action === 'luoshu.remove') {
      if (!this.files.delete(path)) throw { code: 'not-found' }
      return null
    }
    if (call.action === 'luoshu.write') {
      this.files.set(path, (call.args as { text: string }).text)
      return { written: path }
    }
    // A missing note is not-found only now, after decide
    if (!this.files.has(path)) throw { code: 'not-found' }
    return { text: this.files.get(path) }
  }

  release(call: Call, _prepared: Prepared): void {
    this.released.push(call.callId)
  }
}

// The caller's own space, keyed by the caller the router names
export class FakeStorage implements Provider {
  readonly values = new Map<string, unknown>()

  async prepare(): Promise<Prepared> {
    return { scope: {} }
  }

  async perform(call: Call): Promise<unknown> {
    const { key, value } = call.args as { key: string, value?: unknown }
    const where = `${JSON.stringify(call.caller)}/${key}`
    if (call.action.endsWith('.set')) this.values.set(where, value)
    return this.values.get(where) ?? null
  }
}

export class FakeLog {
  readonly records: { event: string, fields: Record<string, unknown> }[] = []
  // Each named batch appendMany wrote, the audit writer's, by its id and size
  readonly batches: { id: string | undefined, size: number }[] = []
  failing = false
  healthy = true
  // Refuses these events while staying healthy, as EventLog does with a field it refuses
  refuses = new Set<string>()
  segments: LogSegment[] = [{ segment: 1, lines: 2, first: 1, last: 2, start: 'zero', breaks: [] }]
  verification: LogVerification = { ok: true }

  async append(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    if (this.failing) {
      this.healthy = false
      throw new Error('disk full')
    }
    this.healthy = true
    if (this.refuses.has(event)) throw new Error('field name is not allowed')
    this.records.push({ event, fields })
  }

  // One batch lands whole or not at all, as EventLog's does
  async appendMany(batch: readonly { event: string, fields?: Record<string, unknown> }[], options: { id?: string } = {}): Promise<void> {
    if (this.failing) {
      this.healthy = false
      throw new Error('disk full')
    }
    this.healthy = true
    if (batch.some(({ event }) => this.refuses.has(event))) throw new Error('field name is not allowed')
    if (options.id !== undefined) this.batches.push({ id: options.id, size: batch.length })
    for (const { event, fields } of batch) this.records.push({ event, fields: fields ?? {} })
  }

  async history(): Promise<LogSegment[]> {
    return this.segments
  }

  async verify(): Promise<LogVerification> {
    return this.verification
  }

  events(name: string) {
    return this.records.filter(record => record.event === name)
  }
}

// The plugin's end of a channel
export class Side {
  readonly port: MessagePort
  readonly inbox: Message[] = []
  private id = 1
  private readonly waiting: { match: (message: Message) => boolean, done: (message: Message) => void }[] = []

  constructor(port: MessagePort) {
    this.port = port
    port.on('message', (message: Message) => {
      this.inbox.push(message)
      for (const wait of [...this.waiting]) {
        if (!wait.match(message)) continue
        this.waiting.splice(this.waiting.indexOf(wait), 1)
        wait.done(message)
      }
    })
  }

  post(message: unknown): void {
    this.port.postMessage(message)
  }

  call(action: string, args?: unknown, extra: object = {}): number {
    const id = this.id++
    this.post({ v: 1, kind: 'call', id, action, args, ...extra })
    return id
  }

  waitFor(match: (message: Message) => boolean, ms = 2000): Promise<Message> {
    const found = this.inbox.find(match)
    if (found !== undefined) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('nothing matched in time')), ms)
      this.waiting.push({ match, done: message => {
        clearTimeout(timer)
        resolve(message)
      } })
    })
  }

  reply(id: number, ms?: number): Promise<Message> {
    return this.waitFor(message => message.kind === 'reply' && message.id === id, ms)
  }

  async ask(action: string, args?: unknown, extra?: object): Promise<Message> {
    return this.reply(this.call(action, args, extra))
  }

  // A delivered call, by its action
  delivered(action: string, ms?: number): Promise<Message> {
    return this.waitFor(message => message.kind === 'call' && message.action === action, ms)
  }

  repliesTo(id: number): Message[] {
    return this.inbox.filter(message => message.kind === 'reply' && message.id === id)
  }

  answer(callId: unknown, result: unknown): void {
    this.post({ v: 1, kind: 'reply', callId, ok: true, result })
  }

  // Events and signals the bus pushed to this half, oldest first
  events(): Message[] {
    return this.inbox.filter(message => message.kind === 'event')
  }

  ack(seq: unknown): void {
    this.post({ v: 1, kind: 'ack', seq })
  }
}

export const code = (reply: Message) => (reply.refusal as { code?: string } | undefined)?.code ?? null

const live: { router: Router, ports: MessagePort[] }[] = []

// What the harness builds recording from: the log, null for none, how long its lane waits to try again, how often its
// writer writes and where the log failing is told
export type RecordingOver = { log?: CoreLog | null, coreRecordRetryMs?: number, auditEveryMs?: number, logFailed?: () => boolean | void }

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

// The router's options with what a test hands in through its door in place of the plugins manager's
// gateActions false hands the router no gate part and no count of the gate's time
export type HarnessOptions = Partial<RouterOptions> & RecordingOver & { core?: Served, drawer?: Served, asks?: Asks, gateActions?: false }

export function harness(given: HarnessOptions = {}) {
  const { log: logGiven, coreRecordRetryMs, auditEveryMs, logFailed, core: coreGiven, drawer, asks: asksGiven, gateActions: withGate, ...over } = given
  const pluginsManager = new FakePluginsManager()
  const gate = new FakeGate(pluginsManager)
  const luoshu = new FakeLuoshu()
  const storage = new FakeStorage()
  const guards: Record<string, FakeGuard> = {}
  const providers: Record<string, Provider> = { luoshu, storage }
  const log = logGiven === undefined ? new FakeLog() : logGiven
  const debug: { plugin: string | null, caller: Caller, action: string, text: string }[] = []
  const asks: { ask: string, access: Access }[] = []
  // The real flood control on the router's clock and the fake plugins manager's limits, unless a test hands its own
  const limits = new Limits(() => pluginsManager.limits())
  const clock = over.clock ?? (() => performance.now())
  const floodControl = createFloodControl({ limit: (plugin, name) => limits.of(plugin, name), clock })
  // Recording over the log, off while the fake plugins manager says nothing. Audit records land only on flush unless a
  // test names how often the writer writes, so a test decides when the writer takes them
  const parts: { router: Router | null, recording: Recording | null } = { router: null, recording: null }
  const recording: Recording | null = log === null ? null : createRecording({
    log,
    off: () => pluginsManager.nothing,
    limit: name => limits.of(null, name),
    hash: sha256,
    ...(over.now !== undefined ? { now: over.now } : {}),
    clock,
    retryMs: coreRecordRetryMs ?? 5000,
    everyMs: 'auditEveryMs' in given ? auditEveryMs ?? 100 : 3_600_000,
    noticed: () => parts.router?.status(),
    ...(logFailed !== undefined ? { failed: logFailed } : {}),
  })
  // The gate module's actions over the gate the router asks, as wire.ts makes them
  const gateActions = createGateActions({
    gate: () => (over.gate ?? (() => gate))(),
    table: () => pluginsManager,
    stopping: () => parts.router?.shutting() === true,
    limit: plugin => limits.of(plugin, 'filterMsPerSecond'),
    clock,
    fault: step => parts.recording?.coalesced('fault', { plugin: 'gate', step }),
  })
  const router = new Router({
    ...(withGate === false ? {} : { gateTime: gateActions.time }),
    floodControl: () => floodControl,
    gate: () => gate,
    guards: id => guards[id] ?? null,
    providers: id => providers[id] ?? null,
    recording,
    debug: entry => { debug.push(entry) },
    ...over,
  })
  // What the plugins manager and the runtime hand in through the router's door: the table, the core actions, the
  // prompt behind an ask and the listeners for what the ways in heard
  router.read(pluginsManager)
  // The plugins manager's core.self and core.refused as it serves them, the second through the recording handed in
  const core: Served = coreGiven ?? (async call => {
    if (call.action === 'core.self') return call.caller
    if (call.action !== 'core.refused') throw { code: 'unavailable' }
    const { reason, count } = call.args as { reason: string, count: number }
    const handed = over.recording !== undefined ? over.recording : recording
    if (call.caller.kind === 'plugin') handed?.coalesced(`${call.caller.id}.refused`, { reason }, undefined, count)
    return null
  })
  for (const part of ['plugins-manager', 'runtime'] as const) router.serve(part, core)
  if (drawer !== undefined) router.serve('drawer', drawer)
  // A test that names asks as undefined has no prompt to raise
  const raising = 'asks' in given ? asksGiven : { raise: (ask: string, access: Access) => { asks.push({ ask, access }); return `req-${asks.length}` } }
  if (raising !== undefined) router.asks(raising)
  router.onWayClosed((caller, reason) => pluginsManager.crashed(caller, reason))
  router.onHeard((caller, kind) => pluginsManager.heard(caller, kind))
  parts.router = router
  const ports: MessagePort[] = []
  live.push({ router, ports })
  // A plugin half on a real MessageChannel, the router holding the other end
  const connect = (caller: Caller): Side => {
    const { port1, port2 } = new MessageChannel()
    ports.push(port1, port2)
    router.register(port1, caller)
    return new Side(port2)
  }
  // recording is the one the router was handed, a test's own included, serving the log's reads as wire.ts hands it
  const handed = over.recording !== undefined ? over.recording : recording
  if (handed !== recording) recording?.close()
  if (handed !== null) router.serve('recording', call => handed.serve(call))
  parts.recording = handed
  if (withGate !== false) router.serve('gate', gateActions.serve)
  return { router, pluginsManager, gate, luoshu, storage, guards, providers, log: log as FakeLog, debug, asks, connect, recording: handed as Recording }
}

// A window's way in with a sender check that knows one sender per window
export function windowWay(router: Router, senders: Record<string, Caller>) {
  const receive = router.window<string>(sender => senders[sender] ?? null)
  const replies: Message[] = []
  let id = 1
  return {
    replies,
    post(sender: string, message: unknown): void {
      receive(sender, message, reply => { replies.push(reply as Message) })
    },
    // Events go back the way the window's subscribe came, so they land among the replies
    events(): Message[] {
      return replies.filter(message => message.kind === 'event')
    },
    async ask(sender: string, action: string, args?: unknown, extra: object = {}): Promise<Message> {
      const mine = id++
      receive(sender, { v: 1, kind: 'call', id: mine, action, args, ...extra }, reply => { replies.push(reply as Message) })
      for (let i = 0; i < 200; i++) {
        const found = replies.find(reply => reply.id === mine)
        if (found !== undefined) return found
        await tick(5)
      }
      throw new Error('no reply in time')
    },
  }
}

// A host half on an in-process handle
export function hostHalf(router: Router, caller: Caller) {
  const inbox: Message[] = []
  const handle = router.handle(caller, message => { inbox.push(message as Message) })
  let id = 1
  return {
    inbox,
    handle,
    async ask(action: string, args?: unknown, extra: object = {}): Promise<Message> {
      const mine = id++
      handle.post({ v: 1, kind: 'call', id: mine, action, args, ...extra })
      for (let i = 0; i < 400; i++) {
        const found = inbox.find(message => message.kind === 'reply' && message.id === mine)
        if (found !== undefined) return found
        await tick(2)
      }
      throw new Error('no reply in time')
    },
  }
}

export function cleanup(): void {
  for (const { router, ports } of live.splice(0)) {
    router.close()
    for (const port of ports) port.close()
  }
}
