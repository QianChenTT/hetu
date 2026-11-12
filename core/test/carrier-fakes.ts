import { MessageChannel, type MessagePort } from 'node:worker_threads'
import type { Capability } from '../api/capabilities.ts'
import type { Caller } from '../api/envelope.ts'
import type { FloorConstant } from '../api/floor.ts'
import { scopeMatches } from '../api/scope.ts'
import type { Access, Call, Decision, Gate, Guard, GuardCall, LogSegment, LogVerification, Prepared, Provider, Sample, SlotState } from '../api/slots.ts'
import { windowGrants } from '../api/windows.ts'
import { Carrier } from '../backend/carrier/carrier.ts'
import type { CarrierOptions, HumanLimits, Loader, PluginInfo } from '../backend/carrier/seams.ts'

export const worker = (id: string, incarnation = 1): Caller => ({ kind: 'plugin', id, half: 'worker', incarnation })
export const host = (id: string, incarnation = 1): Caller => ({ kind: 'plugin', id, half: 'host', incarnation })
export const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
export const trusted: Caller = { kind: 'window', role: 'trusted', n: 0 }

export type Message = Record<string, unknown>

export const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

export class FakeLoader implements Loader {
  slots: Record<string, SlotState> = { gate: 'on', watchdog: 'on', capabilities: 'on' }
  plugins: Record<string, PluginInfo> = {}
  current = 1
  // Writable here, so a test can set the human's limits
  human: { all: Partial<Record<FloorConstant, number>>, plugins: Record<string, Partial<Record<FloorConstant, number>>> } = { all: {}, plugins: {} }
  nothing = false
  crashes: { caller: Caller, reason: string }[] = []
  lifecycle: { caller: Caller, kind: string }[] = []

  slot(id: string): SlotState {
    return this.slots[id] ?? 'absent'
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

  recordNothing(): boolean {
    return this.nothing
  }

  crashed(caller: Caller, reason: 'closed' | 'flood'): void {
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
  private readonly loader: FakeLoader

  constructor(loader: FakeLoader) {
    this.loader = loader
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

  // The grant table's answer on the current StateView
  granted(access: Access): Decision {
    const view = this.loader.current
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
    // A move's two ends, in the order the carrier built its raw scope
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
    // Every name the carrier's canList lets through, as the luoshu lists them
    if (call.action === 'luoshu.list') return { paths: [...this.files.keys()].sort().filter(name => call.canList?.(name) === true), next: null }
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

// The caller's own space, keyed by the caller the carrier names
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

const live: { carrier: Carrier, ports: MessagePort[] }[] = []

export function harness(over: Partial<CarrierOptions> = {}) {
  const loader = new FakeLoader()
  const gate = new FakeGate(loader)
  const luoshu = new FakeLuoshu()
  const storage = new FakeStorage()
  const guards: Record<string, FakeGuard> = {}
  const providers: Record<string, Provider> = { luoshu, storage }
  const samples: Sample[] = []
  const log = new FakeLog()
  const debug: { plugin: string | null, caller: Caller, action: string, text: string }[] = []
  const asks: { ask: string, access: Access }[] = []
  loader.installed('luoshu')
  loader.installed('storage')
  // The luoshu's manifest declares the two topics it publishes
  loader.plugins.luoshu.topics = ['changed', 'outside']
  const carrier = new Carrier({
    loader,
    gate: () => gate,
    guards: id => guards[id] ?? null,
    providers: id => providers[id] ?? null,
    watchdog: () => ({ sample: sample => { samples.push(sample) } }),
    log,
    asks: { raise: (ask, access) => { asks.push({ ask, access }); return `req-${asks.length}` } },
    debug: entry => { debug.push(entry) },
    // Audit records land only on flush, so a test decides when the writer takes them
    auditEveryMs: 3_600_000,
    ...over,
  })
  const ports: MessagePort[] = []
  live.push({ carrier, ports })
  // A plugin half on a real MessageChannel, the carrier holding the other end
  const connect = (caller: Caller): Side => {
    const { port1, port2 } = new MessageChannel()
    ports.push(port1, port2)
    carrier.register(port1, caller)
    return new Side(port2)
  }
  return { carrier, loader, gate, luoshu, storage, guards, providers, samples, log, debug, asks, connect }
}

// A window's way in with a sender check that knows one sender per window
export function windowWay(carrier: Carrier, senders: Record<string, Caller>) {
  const receive = carrier.window<string>(sender => senders[sender] ?? null)
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
export function hostHalf(carrier: Carrier, caller: Caller) {
  const inbox: Message[] = []
  const handle = carrier.handle(caller, message => { inbox.push(message as Message) })
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
  for (const { carrier, ports } of live.splice(0)) {
    carrier.close()
    for (const port of ports) port.close()
  }
}
