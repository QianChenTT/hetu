import { createHash, randomBytes } from 'node:crypto'
import { coreActions, eventActions, providerActions, type CoreAction, type ProviderAction } from '../../api/actions.ts'
import type { CapabilityType } from '../../api/capabilities.ts'
import {
  ack as ackSchema, answer as answerSchema, caller as callerSchema, cancel as cancelSchema, kindOf, reasonCodes,
  calleeRefusalCodes, refusalCodes, requestEnvelope, token, VERSION, type Caller, type ReasonCode, type Refusal, type RefusalCode,
} from '../../api/envelope.ts'
import { MAX_TIMER_MS, type FloorConstant } from '../../api/floor.ts'
import {
  coreNamespaces, guardableActions, guards as expectedGuards, providers as providerIds, qualifiedName, slotIds,
  type GuardableAction,
} from '../../api/ids.ts'
import { frozen, measurePlain } from '../../api/plain.ts'
import {
  pluginStates, slotStates, type Access, type Call, type Gate, type GuardCall, type Prepared, type Scope,
  type SlotState,
} from '../../api/slots.ts'
import type { Field } from '../../lib/event-log.ts'
import { Bus, type Paths } from './bus.ts'
import { countMessage, newRate, type Rate } from '../../api/rate.ts'
import { Limits } from './limits.ts'
import { AuditQueue, Coalesced, FloorLane, type Join } from './records.ts'
import type { CarrierOptions, Landing, PluginInfo, Port, Served } from './seams.ts'

type Send = (message: unknown) => void

// A way in: one port, one host handle or one window, with its caller bound when it was made. principal is whose
// ceiling and limits apply, the plugin across its halves and incarnations or the window
type Way = {
  caller: Caller
  key: string
  principal: string
  plugin: string | null
  via: 'port' | 'handle' | 'window'
  send: Send | null
  close: (() => void) | null
  open: boolean
  ownClose: boolean
  rate: Rate
  // Calls this way made, by the caller's own id
  made: Map<number, Pending>
  // Calls delivered to this way, by call id. Replies, parents and filterReadable look only here
  delivered: Map<string, Pending>
}

type Root = { principal: string, plugin: string | null, caller: Caller }

type Pending = {
  callId: string
  id: number
  way: Way
  answer: Send
  caller: Caller
  onBehalf: string | undefined
  action: string
  parent: Pending | null
  root: Root
  depth: number
  deadline: number
  // The deadline on the clock no change of the wall clock moves. The steps check it before they hand a call on, since
  // a gate or a guard can run past it before the timer gets a turn
  due: number
  bytes: number
  charged: [string, string | null][]
  children: Set<Pending>
  callee: Way | null
  host: Way | null
  timer: ReturnType<typeof setTimeout> | null
  done: boolean
  started: number
  gate: SlotState
  scope: Scope | undefined
  coalesce: boolean
  // How far a throttled filterReadable for this call got, so the next try goes on from there
  filtering: Filtering | null
}

// The paths by their hash, the gate and StateView the answers came from, how many were asked about and the indexes kept
type Filtering = { hash: string, gate: object, view: number | null, asked: number, kept: number[] }

const hashOf = (paths: readonly string[]) => createHash('sha256').update(JSON.stringify(paths)).digest('hex')

type Target =
  | { kind: 'core', spec: CoreAction }
  | { kind: 'events', action: string }
  | { kind: 'served', namespace: 'ui' }
  | { kind: 'provider', provider: string, spec: ProviderAction }
  | { kind: 'plugin', target: string, name: string }

type Kind =
  | { kind: 'core' | 'served' | 'free' }
  | { kind: 'power', capability: CapabilityType, scope: Scope }

type No = { code: RefusalCode, reason?: ReasonCode, request?: string }
type Outcome = { ok: true, result: unknown } | ({ ok: false } & No)

// What the audit record of a call names, read from the envelope once it parsed. parent is the live call it named
type About = { id: number | null, action: string, onBehalf: string | undefined, parent: Pending | null }

// Who the gate is asked for: a call, or a subscription the bus asks about again
type Asker = { caller: Caller, onBehalf: string | undefined, action: string }

type Shaped =
  | ({ ok: false, no: No } & About)
  | ({ ok: true, id: number, target: Target, args: unknown, bytes: number } & About)

const no = (code: RefusalCode, reason?: ReasonCode): Outcome => ({ ok: false, code, ...(reason ? { reason } : {}) })

// Random, in core/api's token grammar
const newId = () => randomBytes(16).toString('base64url')

const isOne = <T extends string>(list: readonly T[], value: unknown): value is T => (list as readonly unknown[]).includes(value)

function keyOf(caller: Caller): string {
  if (caller.kind === 'plugin') return `plugin:${caller.id}:${caller.half}:${caller.incarnation}`
  if (caller.kind === 'window') return `window:${caller.role}:${caller.n}`
  return `content:${caller.plugin}:${caller.token}`
}

function field(message: unknown, name: string): unknown {
  return typeof message === 'object' && message !== null ? (message as Record<string, unknown>)[name] : undefined
}

// The plugin id or core namespace an action or a topic starts with
const namespaceOf = (name: string) => name.slice(0, name.indexOf('.'))

// A subscriber as a floor record names it
function whoOf(caller: Caller): Record<string, Field> {
  if (caller.kind === 'plugin') return { plugin: caller.id, half: caller.half }
  if (caller.kind === 'window') return { window: caller.role }
  return { plugin: caller.plugin }
}

// A record's value holds at most MAX_TOPICS_TEXT characters, so a record names the topics that fit, space separated,
// with how many there were in all
const MAX_TOPICS_TEXT = 4096
function topicsOf(topics: readonly string[]): Record<string, Field> {
  let listed = ''
  for (const topic of topics) {
    const next = listed === '' ? topic : `${listed} ${topic}`
    if (next.length > MAX_TOPICS_TEXT) break
    listed = next
  }
  return { topics: listed, count: topics.length }
}

// The topics later subscribes in the same second left standing, in the order first seen, for the one record that ends
// the second. Topic names hold no spaces
const joinTopics: Join = (held, next) => {
  const named = (fields: Record<string, Field> | null) => (fields === null || fields.topics === '' ? [] : String(fields.topics).split(' '))
  return { ...next, ...topicsOf([...new Set([...named(held), ...named(next)])]) }
}

// The caller's own id and action, read only to answer a call the shape step refused. An action outside the grammar is
// never echoed or recorded
function readId(message: unknown): number | null {
  const id = field(message, 'id')
  return Number.isSafeInteger(id) && (id as number) >= 0 ? id as number : null
}

function readAction(message: unknown): string {
  const action = field(message, 'action')
  return qualifiedName.safeParse(action).success ? action as string : ''
}

// A refusal a provider or a seam gave or threw: its code and a fixed reason, nothing else
function refusalIn(value: unknown): No | null {
  const code = field(value, 'code')
  if (!isOne(refusalCodes, code)) return null
  const reason = field(value, 'reason')
  return isOne(reasonCodes, reason) ? { code, reason } : { code }
}

// The canonical scope prepare gave, copied, so what the gate and the guards judge can't change under them
function preparedIn(value: unknown): Prepared | null {
  const scope = field(value, 'scope')
  if (typeof scope !== 'object' || scope === null) return null
  const paths = field(scope, 'paths')
  const target = field(scope, 'target')
  const baseVersion = field(value, 'baseVersion')
  if (paths !== undefined && (!Array.isArray(paths) || !paths.every(path => typeof path === 'string'))) return null
  if (target !== undefined && typeof target !== 'string') return null
  if (baseVersion !== undefined && typeof baseVersion !== 'string') return null
  return frozen({
    scope: { ...(paths !== undefined ? { paths: [...paths] } : {}), ...(target !== undefined ? { target } : {}) },
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  })
}

// The one path every call and reply takes, with the floor rules in it. The caller always comes from the way in.
// Policy comes from the slots it asks: the gate decides and the carrier enforces
export class Carrier {
  private readonly options: CarrierOptions
  private readonly now: () => number
  private readonly clock: () => number
  private readonly limits: Limits
  private readonly lane: FloorLane
  private readonly coalesced: Coalesced
  private readonly queue: AuditQueue
  private readonly ways = new Map<string, Way>()
  private readonly ports = new WeakSet<object>()
  private readonly inflight = new Map<string, { calls: number, bytes: number }>()
  // The gate's time filterReadable took in the current second for each caller of a live call, by principal
  private readonly filtered = new Map<string, { second: number, spent: number }>()
  private readonly guardsFor: (action: GuardableAction) => readonly string[]
  private readonly bus: Bus
  // The StateView number core.security last went out for
  private announced: number | null | undefined = undefined
  private closed = false
  // Shutdown began: the loader reports what it stops as failed, so a slot, guard or provider that is down answers stopped
  private shutting = false

  constructor(options: CarrierOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.clock = options.clock ?? (() => performance.now())
    this.limits = new Limits(() => options.loader.limits())
    this.lane = new FloorLane(options.log, {
      bound: () => this.limits.of(null, 'floorBacklog'),
      muted: () => this.muted(),
      retryMs: options.floorRetryMs ?? 5000,
    })
    this.coalesced = new Coalesced(this.lane)
    this.queue = new AuditQueue(() => this.limits.of(null, 'auditQueue'))
    this.guardsFor = options.guardsFor ?? (action => expectedGuards[action])
    this.bus = new Bus({
      state: () => this.busState(),
      canRead: (caller, path) => this.readable(caller, path),
      recheck: (caller, topic) => this.recheck(caller, topic),
      limit: (plugin, name) => this.limits.of(plugin, name),
      // Coalesced, since a publisher's pace or a subscriber's own can make them
      // Shutdown takes the gate down on its way out, which is no failure, so the bus records nothing then
      dropped: (caller, why) => {
        if (!this.shutting) this.coalesced.hit('events.dropped', { ...whoOf(caller), why })
      },
      // One record each, since a change of the gate or the grants makes them
      changed: (caller, change, topics) => {
        if (!this.shutting) this.lane.write(`events.${change}`, { ...whoOf(caller), ...topicsOf(topics) })
      },
    })
  }

  // The audit queue's pair, which the log plugin's handle is to wrap
  readonly audit = {
    next: (max: number) => this.queue.next(max),
    ack: (seq: number) => this.queue.ack(seq),
  }

  // For the loader, before it records core.stopping. The six slot states have no stopping, so from here a slot, guard
  // or provider that is down, for whatever reason, answers stopped where it would answer policy-down, guard-down or
  // unavailable. A gate that throws or a guard that answers late still answers as a fault. The bus keeps applying the
  // gate to the end, since a publish or a subscribe asks again first. It records no change to the subscriptions it
  // holds. Audit records keep queueing until close counts them
  stopping(): void {
    this.shutting = true
  }

  // The answer for something that is down: what it is outside shutdown, stopped once shutdown began
  private down(code: 'policy-down' | 'guard-down' | 'unavailable'): RefusalCode {
    return this.shutting ? 'stopped' : code
  }

  // A floor record from the core: boot, the loader and the carrier itself
  floor(event: string, fields: Record<string, Field> = {}): void {
    this.lane.write(event, fields)
  }

  // The floor lane's backlog, for a log that came back
  flushFloor(): Promise<void> {
    return this.lane.flush()
  }

  // For the loader, after it changed a slot state, a plugin state or the StateView. Once the gate's state or the
  // StateView moved, the bus asks the gate again about every subscription it holds. Windows hear core.status, and
  // core.security once a new StateView applied a security change. The first StateView the carrier reads is where it
  // starts, not a change
  changed(): void {
    if (this.closed || this.shutting) return
    this.bus.sync()
    this.bus.emit('core.status')
    const view = this.view()
    if (view === this.announced) return
    const first = this.announced === undefined
    this.announced = view
    if (!first) this.bus.emit('core.security')
  }

  // Binds a plugin half to one end of a channel. The carrier starts the port, since a paused MessagePortMain emits
  // nothing, close included
  register(port: Port, caller: Caller): void {
    const bound = this.bindable(caller)
    if (this.ports.has(port)) throw new Error('port already registered')
    this.ports.add(port)
    const way = this.addWay(bound, 'port', message => port.postMessage(message), () => port.close())
    port.on('message', message => this.receive(way, message, way.send!))
    // A message that couldn't be read still counts against the rate
    port.on('messageerror', () => this.receive(way, undefined, way.send!))
    port.on('close', () => this.portClosed(way))
    port.start()
  }

  // A host half's in-process way in, bound like a port. Messages are copied both ways as a port copies them, so a host
  // half can't change one after the carrier has read it. They arrive in a later microtask as a port's would
  handle(caller: Caller, receive: Send): { post: Send } {
    const bound = this.bindable(caller)
    const way = this.addWay(bound, 'handle', message => {
      const copy = structuredClone(message)
      queueMicrotask(() => {
        try {
          const result: unknown = receive(copy)
          // An async receive fails later and an unhandled rejection would take main down
          if (result instanceof Promise) result.catch(() => {})
        } catch {}
      })
    }, null)
    return {
      post: message => {
        let copy: unknown
        try {
          copy = structuredClone(message)
        } catch {}
        queueMicrotask(() => this.receive(way, copy, way.send!))
      },
    }
  }

  // The way in for windows. check names the window that sent a message and runs before anything else, before any
  // await. A sender it doesn't name is dropped unread. Step 12 gives the real check. answer must keep working after the
  // reply, since the window's events go back on the answer of its newest subscribe
  window<S>(check: (sender: S) => Caller | null): (sender: S, message: unknown, answer: Send) => void {
    return (sender, message, answer) => {
      let named: unknown
      try {
        named = check(sender)
      } catch {
        return
      }
      const parsed = callerSchema.safeParse(named)
      if (!parsed.success || parsed.data.kind !== 'window' || this.closed) return
      const caller = frozen(parsed.data)
      const way = this.ways.get(keyOf(caller)) ?? this.addWay(caller, 'window', null, null)
      this.receive(way, message, reply => {
        try {
          answer(reply)
        } catch {}
      })
    }
  }

  // For the loader: a planned stop or a revoked incarnation. Its subscriptions and credits go at once, calls delivered to
  // the way answer code and the calls it made are given up. Not a crash, so nothing is reported
  end(caller: Caller, code: 'stopped' | 'crashed' = 'stopped'): void {
    const way = this.ways.get(keyOf(caller))
    if (way === undefined) return
    this.ways.delete(way.key)
    this.shut(way)
    this.bus.drop(way)
    for (const pending of [...way.delivered.values()]) this.stop(pending, code)
    for (const pending of [...way.made.values()]) this.stop(pending, 'stopped')
  }

  // For the loader: a lifecycle message (init, deps, stop or ping) down a half's own way. A way that is gone or was
  // never registered drops it. Nothing the core sends counts against the half's rate
  send(caller: Caller, message: unknown): void {
    const way = this.ways.get(keyOf(caller))
    if (way === undefined || !way.open || way.send === null) return
    way.send(message)
  }

  // For the loader: a floor record it can wait on, landed once on disk, muted while recording is off or lost. A record
  // still waiting when signal aborts comes out and settles lost
  record(event: string, fields: Record<string, Field>, signal?: AbortSignal): Promise<Landing> {
    return this.lane.write(event, fields, signal)
  }

  // For the loader: a floor constant as the carrier enforces it for one plugin, so the loader's start and stop
  // deadlines follow the same values
  limit(plugin: string, name: FloorConstant): number {
    return this.limits.of(plugin, name)
  }

  close(): void {
    this.closed = true
    for (const way of [...this.ways.values()]) this.end(way.caller)
    this.coalesced.close()
    // Records the log plugin never acknowledged are lost with the run and counted
    const held = this.queue.clear()
    if (held > 0 && !this.muted()) this.lane.write('audit.dropped', { count: held, why: 'shutdown' })
    this.lane.close()
  }

  private bindable(caller: Caller): Caller {
    const parsed = callerSchema.safeParse(caller)
    // Windows come through window() and content frames are reserved for #97
    if (!parsed.success || parsed.data.kind !== 'plugin') throw new Error('not a plugin caller')
    if (this.closed) throw new Error('carrier closed')
    const bound = frozen(parsed.data)
    if (this.ways.has(keyOf(bound))) throw new Error('caller already registered')
    return bound
  }

  private addWay(caller: Caller, via: Way['via'], send: Send | null, close: (() => void) | null): Way {
    const plugin = caller.kind === 'plugin' ? caller.id : null
    const way: Way = {
      caller,
      key: keyOf(caller),
      principal: caller.kind === 'window' ? `window:${caller.role}:${caller.n}` : `plugin:${plugin}`,
      plugin,
      via,
      send: send === null ? null : message => {
        try {
          send(message)
        } catch {}
      },
      close,
      open: true,
      ownClose: false,
      rate: newRate(),
      made: new Map(),
      delivered: new Map(),
    }
    this.ways.set(way.key, way)
    return way
  }

  // 1 bind: the caller is the way's. Every message counts against the way's rate before it is read
  private receive(way: Way, message: unknown, answer: Send): void {
    if (!way.open || this.closed) return
    const verdict = countMessage(way.rate, this.clock(), name => this.limits.of(way.plugin, name))
    // Closing a window's way would lock the human out, so a window only ever drops
    if (verdict === 'flood' && way.via !== 'window') return this.flood(way)
    if (verdict !== 'pass') return this.dropped(way)
    // A message that throws while it is read is dropped like one that can't be read
    try {
      const kind = kindOf(message)
      if (kind === 'call') void this.call(way, message, answer)
      else if (kind === 'reply') this.answered(way, message)
      else if (kind === 'cancel') this.cancelled(way, message)
      else if (kind === 'ack') this.acked(way, message)
      else if ((kind === 'ready' || kind === 'pong' || kind === 'stopped') && way.plugin !== null) {
        this.options.loader.heard(way.caller, kind)
      }
      // Anything else, another v and the kinds only the carrier sends included, is dropped unread
    } catch {}
  }

  // One over the rate gets no reply. The watchdog hears at most once a second per way, with the count since
  private dropped(way: Way): void {
    way.rate.dropped++
    const now = this.clock()
    if (now - way.rate.toldAt < 1000 || this.slot('watchdog') !== 'on') return
    const watchdog = this.holder(() => this.options.watchdog())
    if (watchdog === null) return
    const count = way.rate.dropped
    way.rate.dropped = 0
    way.rate.toldAt = now
    try {
      watchdog.sample(frozen({ kind: 'dropped', caller: way.caller, count }))
    } catch {
      this.fault('watchdog', 'sample')
    }
  }

  // The flood cap closes the way and reports the plugin crashed with flood. The carrier marks its own close first,
  // since a local close() emits close too
  private flood(way: Way): void {
    this.shut(way)
    this.dead(way, 'flood')
  }

  private portClosed(way: Way): void {
    if (way.ownClose) return
    this.dead(way, 'closed')
  }

  private shut(way: Way): void {
    way.ownClose = true
    way.open = false
    try {
      way.close?.()
    } catch {}
  }

  // Its subscriptions and credits go first, so nothing the loader changes on hearing of the crash is sent to the dead
  // way. The loader moves dependents to waiting before crashed returns. Then the calls the plugin held answer crashed,
  // the calls it made are given up and their callees told
  private dead(way: Way, reason: 'closed' | 'flood'): void {
    way.open = false
    if (this.ways.get(way.key) === way) this.ways.delete(way.key)
    this.bus.drop(way)
    try {
      this.options.loader.crashed(way.caller, reason)
    } catch {}
    for (const pending of [...way.delivered.values()]) this.stop(pending, 'crashed')
    for (const pending of [...way.made.values()]) this.stop(pending, 'crashed')
  }

  // Nothing escapes: a call no step could take is dropped and one in flight fails
  private async call(way: Way, message: unknown, answer: Send): Promise<void> {
    let pending: Pending | null = null
    try {
      const started = this.now()
      const callId = newId()
      const shaped = this.shape(way, message)
      if (!shaped.ok) return this.early(way, answer, callId, shaped, shaped.no, started)
      const kind = this.floorOf(way, shaped.target, shaped.args)
      if ('code' in kind) return this.early(way, answer, callId, shaped, kind, started)
      pending = this.admit(way, answer, callId, shaped, kind, started)
      if (pending === null) return this.early(way, answer, callId, shaped, { code: 'throttled' }, started)
      await this.run(pending, shaped.target, shaped.args, kind)
    } catch (err) {
      if (pending === null) return
      this.debugOf(pending, null, err)
      this.finish(pending, no('failed'))
    }
  }

  // 2 shape: the strict envelope, args within the caller's cap, the schema of a core or provider action and a parent
  // that names a live call delivered on this same way
  private shape(way: Way, message: unknown): Shaped {
    const parsed = requestEnvelope.safeParse(message)
    if (!parsed.success) {
      return { ok: false, id: readId(message), action: readAction(message), onBehalf: undefined, parent: null, no: { code: 'invalid' } }
    }
    const { id, action, parent: parentId, onBehalf } = parsed.data
    // Looked up first so a refused call's record still names its root. A call past its due time is as good as over,
    // though its timer hasn't run yet
    const named = parentId === undefined ? null : way.delivered.get(parentId) ?? null
    const parent = named !== null && !named.done && this.clock() < named.due ? named : null
    const refuse = (code: RefusalCode, reason?: ReasonCode): Shaped =>
      ({ ok: false, id, action, onBehalf, parent, no: reason ? { code, reason } : { code } })
    const measured = measurePlain(parsed.data.args, this.limits.of(way.plugin, 'argumentBytes'))
    if (!measured.ok) return refuse('invalid', measured.tooLarge ? 'too-large' : undefined)
    // One live call per id, or a reply and a cancel couldn't tell two apart
    if (way.made.has(id)) return refuse('invalid')

    const dot = action.indexOf('.')
    const namespace = action.slice(0, dot)
    let target: Target
    let args = parsed.data.args
    if (namespace === 'events') {
      const spec = eventActions[action]
      const checked = spec?.args.safeParse(args)
      if (spec === undefined || !checked?.success) return refuse('invalid')
      target = { kind: 'events', action }
      args = checked.data
    } else if (namespace === 'ui') {
      target = { kind: 'served', namespace }
    } else if (isOne(coreNamespaces, namespace)) {
      const spec = coreActions[action]
      const checked = spec?.args.safeParse(args)
      if (spec === undefined || !checked?.success) return refuse('invalid')
      target = { kind: 'core', spec }
      args = checked.data
    } else if (providerIds[namespace as keyof typeof providerIds] !== undefined) {
      const spec = providerActions[action]
      const checked = spec?.args.safeParse(args)
      if (spec === undefined || !checked?.success) return refuse('invalid')
      target = { kind: 'provider', provider: providerIds[namespace as keyof typeof providerIds], spec }
      args = checked.data
    } else {
      target = { kind: 'plugin', target: namespace, name: action.slice(dot + 1) }
    }

    if (parentId !== undefined) {
      if (parent === null) return refuse('invalid')
      if (parent.depth + 1 > this.limits.of(way.plugin, 'parentDepth')) return refuse('invalid')
    }
    return { ok: true, id, action, onBehalf, target, args, bytes: measured.bytes, parent }
  }

  // 3 floor: who may call a core action, security.* and watchdog.* included, the trusted window held to core actions
  // and the free actions that skip the gate. Never asks the gate
  private floorOf(way: Way, target: Target, args: unknown): Kind | No {
    const { caller } = way
    const trusted = caller.kind === 'window' && caller.role === 'trusted'
    if (target.kind === 'core') {
      const { from } = target.spec
      if (from === 'windows' && caller.kind !== 'window') return { code: 'not-granted' }
      if (from === 'trusted' && !trusted) return { code: 'not-granted' }
      if (from === 'watchdog' && !(this.isWatchdog(way) && this.watchable(field(args, 'plugin')))) return { code: 'not-granted' }
      return { kind: 'core' }
    }
    if (target.kind === 'events') return this.eventsFloor(caller, target.action, args)
    // The trusted window holds core actions and the core topics only and never note content
    if (trusted) return { code: 'not-granted' }
    if (target.kind === 'served') return { kind: 'served' }
    if (target.kind === 'provider') {
      const { capability, scope } = target.spec
      if (capability === null) return { kind: 'free' }
      const paths = scope === 'path' ? [field(args, 'path') as string] : scope === 'paths' ? [...field(args, 'paths') as string[]] : undefined
      return { kind: 'power', capability, scope: frozen(paths === undefined ? {} : { paths }) }
    }
    // A plugin's own halves call each other freely
    if (caller.kind === 'plugin' && caller.id === target.target) return { kind: 'free' }
    return { kind: 'power', capability: 'plugin.call', scope: frozen({ target: target.target }) }
  }

  // The watchdog slot's holder is the install's watchdog, whose host half has an in-process handle. It holds the slot
  // only while the slot is on: starting, failed, absent and tampered act as off and off makes no restarts. The handle
  // can outlive that, minted before start and kept through a stop grace
  private isWatchdog(way: Way): boolean {
    const holder = way.via === 'handle' && way.caller.kind === 'plugin' && way.caller.id === 'watchdog' && way.caller.half === 'host'
    return holder && this.slot('watchdog') === 'on'
  }

  // watchdog.* acts only on sandboxed plugins holding no slot or guard role
  private watchable(plugin: unknown): boolean {
    if (typeof plugin !== 'string' || isOne(slotIds, plugin)) return false
    if (guardableActions.some(action => this.guardsFor(action).includes(plugin))) return false
    return this.info(plugin)?.place === 'sandboxed'
  }

  // 3 floor for events.*, which keeps identity rather than limits, so it holds with the gate off too. A plugin publishes
  // only the topics its manifest declared, from any of its halves. core.* comes only from the carrier and goes only to
  // windows. The trusted window hears nothing else. Publishing, a plugin hearing its own topics, a window hearing core.*
  // and unsubscribing skip the gate. A subscribe to anything else is judged under events.subscribe on those topics
  private eventsFloor(caller: Caller, action: string, args: unknown): Kind | No {
    if (action === 'events.unsubscribe') return { kind: 'free' }
    if (action === 'events.publish') {
      return caller.kind === 'plugin' && this.declares(caller.id, field(args, 'topic') as string) ? { kind: 'free' } : { code: 'not-granted' }
    }
    const topics = [...new Set(field(args, 'topics') as string[])]
    const core = topics.filter(topic => namespaceOf(topic) === 'core')
    if (caller.kind !== 'window' && core.length > 0) return { code: 'not-granted' }
    if (caller.kind === 'window' && caller.role === 'trusted' && core.length < topics.length) return { code: 'not-granted' }
    const own = (topic: string) => caller.kind === 'plugin' && namespaceOf(topic) === caller.id
    const gated = topics.filter(topic => namespaceOf(topic) !== 'core' && !own(topic))
    if (gated.length === 0) return { kind: 'free' }
    return { kind: 'power', capability: 'events.subscribe', scope: frozen({ topics: gated }) }
  }

  // Whether the plugin's manifest declared the topic, published as <id>.<name>
  private declares(id: string, topic: string): boolean {
    if (namespaceOf(topic) !== id) return false
    try {
      const declared = this.info(id)?.topics
      return Array.isArray(declared) && declared.includes(topic.slice(id.length + 1))
    } catch {
      return false
    }
  }

  // 4 ceiling: calls and bytes in flight, charged to the caller and to the root of its parent links
  private admit(way: Way, answer: Send, callId: string, shaped: Extract<Shaped, { ok: true }>, kind: Kind, started: number): Pending | null {
    const { parent, bytes } = shaped
    const root: Root = parent?.root ?? { principal: way.principal, plugin: way.plugin, caller: way.caller }
    const charged: [string, string | null][] = [[way.principal, way.plugin]]
    if (root.principal !== way.principal) charged.push([root.principal, root.plugin])
    for (const [principal, plugin] of charged) {
      const load = this.inflight.get(principal) ?? { calls: 0, bytes: 0 }
      if (load.calls + 1 > this.limits.of(plugin, 'callsInFlight')) return null
      if (load.bytes + bytes > this.limits.of(plugin, 'bytesInFlight')) return null
    }
    for (const [principal] of charged) {
      const load = this.inflight.get(principal) ?? { calls: 0, bytes: 0 }
      load.calls++
      load.bytes += bytes
      this.inflight.set(principal, load)
    }
    const { target } = shaped
    // Never past the longest delay a timer takes, so a raised deadline can't fire at once and stays a safe integer
    const ownDeadline = started + Math.min(this.limits.of(way.plugin, 'callDeadlineMs'), MAX_TIMER_MS)
    // Shrinks along parent, so no sub-call outlives the call it serves
    const deadline = Math.min(ownDeadline, parent?.deadline ?? ownDeadline)
    const left = Math.max(0, deadline - this.now())
    const pending: Pending = {
      callId,
      id: shaped.id,
      way,
      answer,
      caller: way.caller,
      onBehalf: shaped.onBehalf,
      action: shaped.action,
      parent,
      root,
      depth: (parent?.depth ?? 0) + 1,
      deadline,
      due: this.clock() + left,
      bytes,
      charged,
      children: new Set(),
      callee: null,
      host: null,
      timer: null,
      done: false,
      started,
      gate: this.slot('gate'),
      // A path is the caller's own text until prepare gives the canonical one, so a call refused before that records
      // no path. A plugin call's target is already the plugin's id
      scope: kind.kind === 'power' && kind.scope.paths === undefined ? kind.scope : undefined,
      coalesce: target.kind === 'core'
        ? !shaped.action.startsWith('security.') && !shaped.action.startsWith('watchdog.')
        : target.kind === 'provider' ? !target.spec.write : kind.kind === 'free',
      filtering: null,
    }
    way.made.set(pending.id, pending)
    parent?.children.add(pending)
    pending.timer = setTimeout(() => this.stop(pending, 'timeout'), left)
    pending.timer.unref?.()
    return pending
  }

  private async run(pending: Pending, target: Target, args: unknown, kind: Kind): Promise<void> {
    // A subscribe keeps its own precheck, since one made while the gate is down stands rather than being refused
    if (target.kind === 'events') return this.events(pending, args, kind)
    // 5 precheck, for calls with power only
    if (kind.kind === 'power') {
      const refused = this.judge(pending, 'raw', kind.capability, kind.scope)
      if (refused !== null) return this.finish(pending, { ok: false, ...refused })
    }
    // 6 route, then 7 to 10 by the route
    if (target.kind === 'core') return this.coreAction(pending, args)
    if (target.kind === 'served') return this.serve(pending, this.options.served?.[target.namespace], args)
    if (target.kind === 'provider') return this.provide(pending, target.provider, args, kind)
    return this.deliver(pending, target, args, kind)
  }

  // The gate slot's state: decide asks the gate, pass skips it and a code refuses. With the gate off by the human a
  // call with power still needs the log running unless the human switched it off too or turned recording off
  private gateOpen(): 'decide' | 'pass' | RefusalCode {
    const gate = this.slot('gate')
    if (gate === 'on') return 'decide'
    if (gate === 'starting') return 'starting'
    if (gate !== 'off') return this.down('policy-down')
    if (this.muted()) return 'pass'
    const log = this.slot('log')
    if (log === 'on' || log === 'off') return 'pass'
    return log === 'starting' ? 'starting' : this.down('policy-down')
  }

  // 5 precheck at the raw stage and 8 decide at the canonical one. Only an exact allow: true on the current StateView
  // lets a call on. A throw refuses this one call and is recorded. An ask, at the canonical stage only, becomes
  // needs-confirm with the request the prompt holds
  private judge(pending: Pending, stage: Access['stage'], capability: CapabilityType, scope: Scope): No | null {
    if (stage === 'raw') pending.gate = this.slot('gate')
    return this.decideFor(pending, stage, capability, scope, true)
  }

  // The gate's answer for a call or for a subscription the bus asks about again. prompt is false for the bus, where an
  // ask raises nothing and counts as a refusal, since no call waits on it and the human did nothing
  private decideFor(asker: Asker, stage: Access['stage'], capability: CapabilityType, scope: Scope, prompt: boolean): No | null {
    const open = this.gateOpen()
    if (open === 'pass') return null
    if (open !== 'decide') return { code: open }
    const gate = this.holder(() => this.options.gate())
    if (gate === null) return { code: this.down('policy-down') }
    const access: Access = frozen({
      stage, caller: asker.caller, ...(asker.onBehalf !== undefined ? { onBehalf: asker.onBehalf } : {}),
      action: asker.action, capability, scope,
    })
    let allow: unknown, view: unknown, code: unknown, ask: unknown
    try {
      const decision = gate.decide(access) as unknown
      if (typeof decision !== 'object' || decision === null) return { code: 'not-granted' }
      // Each field once, so a getter can't answer one way to a check and another to the next
      const fields = decision as Record<string, unknown>
      allow = fields.allow
      view = fields.view
      code = fields.code
      ask = fields.ask
    } catch (err) {
      this.fault('gate', stage === 'raw' ? 'precheck' : 'decide')
      this.debugOf(asker, 'gate', err)
      return { code: 'policy-down' }
    }
    const current = this.view()
    if (current === null) return { code: this.down('policy-down') }
    // An answer with no view isn't an answer at all. One on an older view is stale
    if (!Number.isSafeInteger(view)) return { code: 'not-granted' }
    if (view !== current) return { code: 'stale' }
    if (allow === true) return null
    if (stage === 'canonical' && allow === undefined && typeof ask === 'string') {
      const request = prompt ? this.raise(ask, access) : null
      return request === null ? { code: 'not-granted' } : { code: 'needs-confirm', request }
    }
    return { code: allow === false && code === 'switched-off' ? 'switched-off' : 'not-granted' }
  }

  private raise(ask: string, access: Access): string | null {
    try {
      const request = this.options.asks?.raise(ask, access)
      return token.safeParse(request).success ? request as string : null
    } catch {
      return null
    }
  }

  // Core actions: the carrier serves its own and hands the rest to the loader and the runtime
  private async coreAction(pending: Pending, args: unknown): Promise<void> {
    if (pending.action === 'core.self') return this.finish(pending, { ok: true, result: pending.caller })
    if (pending.action === 'core.filterReadable') return this.finish(pending, this.filterReadable(pending.way, args))
    if (pending.action === 'watchdog.limit') {
      this.limits.lower(field(args, 'plugin') as string, field(args, 'constant') as FloorConstant, field(args, 'value') as number)
      return this.finish(pending, { ok: true, result: null })
    }
    return this.serve(pending, this.options.core, args)
  }

  // Only during a live call delivered on this way. The paths the callee may read itself that the call's own caller may
  // read too, every path with the gate off and policy-down while the gate is starting or failed. One message asks the
  // gate up to twice per path, synchronously in main, and scopes shaped for the matcher's worst case make each ask
  // slow. So the gate's time counts against the live call's caller, filterMsPerSecond each second, and one that floods
  // a plugin with calls spends only its own. Past it the call answers throttled and the live call keeps how far it got,
  // so the next try goes on from there and any call finishes within its deadline. That progress is dropped once the
  // gate or the StateView changed, so no answer from before a narrowing stands
  private filterReadable(way: Way, args: unknown): Outcome {
    const live = way.delivered.get(field(args, 'call') as string)
    const paths = field(args, 'paths') as string[]
    if (live === undefined || live.done) return no('invalid')
    const state = this.slot('gate')
    if (state === 'off') return { ok: true, result: [...paths] }
    const gate = state === 'on' ? this.holder(() => this.options.gate()) : null
    if (gate === null) return no(this.down('policy-down'))
    const budget = this.limits.of(live.way.plugin, 'filterMsPerSecond')
    const started = this.clock()
    let spent = this.filtered.get(live.way.principal)
    if (spent === undefined || started - spent.second >= 1000 || started < spent.second) {
      spent = { second: started, spent: 0 }
      this.filtered.set(live.way.principal, spent)
    }
    if (spent.spent >= budget) return no('throttled')
    const view = this.view()
    const before = live.filtering
    live.filtering = null
    const progress: Filtering = before !== null && before.gate === gate && before.view === view && before.hash === hashOf(paths)
      ? before
      : { hash: '', gate, view, asked: 0, kept: [] }
    try {
      while (progress.asked < paths.length) {
        const path = paths[progress.asked]
        if (gate.canRead(way.caller, path) === true && gate.canRead(live.caller, path) === true) progress.kept.push(progress.asked)
        progress.asked++
        if (progress.asked < paths.length && spent.spent + this.clock() - started >= budget) break
      }
    } catch {
      this.fault('gate', 'canRead')
      return no('policy-down')
    } finally {
      spent.spent += this.clock() - started
    }
    if (progress.asked < paths.length) {
      if (progress.hash === '') progress.hash = hashOf(paths)
      live.filtering = progress
      return no('throttled')
    }
    return { ok: true, result: progress.kept.map(at => paths[at]) }
  }

  // 6 route to the bus, then for a subscribe 5 precheck and 8 decide on the topics the gate holds, then 10 perform. A
  // subscribe made while the gate can't be asked stands rather than being refused, so what a plugin subscribed to at
  // start isn't lost. With the gate off it passes as any call with power does. A subscribe whose gated topics all
  // stand used no power yet, so its audit record names only the topics that went live and coalesces like a free call.
  // The standing ones go in an events.waiting record until asking again starts or ends them
  private events(pending: Pending, args: unknown, kind: Kind): void {
    const { way } = pending
    if (pending.action === 'events.publish') {
      this.bus.publish(field(args, 'topic') as string, field(args, 'path') as string | undefined)
      return this.finish(pending, { ok: true, result: null })
    }
    const topics = [...new Set(field(args, 'topics') as string[])]
    if (pending.action === 'events.unsubscribe') {
      this.bus.unsubscribe(way, topics)
      return this.finish(pending, { ok: true, result: null })
    }
    // The bus catches up with the gate first, so a standing subscription the gate now allows starts once
    this.bus.sync()
    if (!this.bus.fits(way, topics, this.limits.of(way.plugin, 'topicsPerHalf'))) return this.finish(pending, no('invalid', 'too-large'))
    const gated = kind.kind === 'power' ? kind.scope.topics ?? [] : []
    const down = gated.length > 0 && this.slot('gate') !== 'off' && !this.askable()
    if (kind.kind === 'power' && !down) {
      for (const stage of ['raw', 'canonical'] as const) {
        const refused = this.judge(pending, stage, kind.capability, kind.scope)
        if (refused !== null) return this.finish(pending, { ok: false, ...refused })
      }
      if (this.clock() >= pending.due) return this.stop(pending, 'timeout')
    }
    const free = new Set(topics.filter(topic => !gated.includes(topic)))
    const holder = {
      owner: way, caller: way.caller, plugin: way.plugin,
      // A window has no way to push on but the answer to its own call
      push: pending.answer,
      alive: () => way.open && this.ways.get(way.key) === way,
    }
    const standing = this.bus.subscribe(holder, topics, free, down)
    if (standing.length > 0) {
      const live = topics.filter(topic => !standing.includes(topic))
      pending.scope = live.length > 0 ? frozen({ topics: live }) : undefined
      if (!gated.some(topic => live.includes(topic))) pending.coalesce = true
      // Counted per half, since the topics are the plugin's to pick
      this.coalesced.hit('events.waiting', { ...whoOf(way.caller), ...topicsOf(standing) }, { by: whoOf(way.caller), join: joinTopics })
    }
    this.finish(pending, { ok: true, result: { standing } })
  }

  // An ack names the way's own events, so a subscriber frees no credits but its own
  private acked(way: Way, message: unknown): void {
    const parsed = ackSchema.safeParse(message)
    if (parsed.success) this.bus.ack(way, parsed.data.seq)
  }

  // What the bus delivers paths under. The key holds everything a subscription the gate holds depends on, so the bus
  // asks again whenever it moves. canRead is true with the gate off by the human whatever the log, since deliveries
  // are never logged, as filterReadable passes every path then. A gate that can't be asked is down
  private busState(): { key: string, paths: Paths, view: number | null } {
    const state = this.slot('gate')
    const view = this.view()
    const paths: Paths = state === 'off' ? 'all' : this.askable() ? 'ask' : 'none'
    return { key: `${state} ${paths} ${view}`, paths, view }
  }

  // The gate can be asked: its slot is on, there is a holder and the StateView can be read. Otherwise every answer
  // would be policy-down, so the bus holds paths back and a subscribe stands
  private askable(): boolean {
    return this.slot('gate') === 'on' && this.holder(() => this.options.gate()) !== null && this.view() !== null
  }

  // canRead on every delivery of a path: only an exact true counts and a throw is a no that is recorded
  private readable(caller: Caller, path: string): boolean {
    const gate = this.holder(() => this.options.gate())
    if (gate === null) return false
    try {
      return gate.canRead(caller, path) === true
    } catch {
      this.fault('gate', 'canRead')
      return false
    }
  }

  // A subscription asked about again, at both stages as a subscribe is. No answer, a throw or one on an older
  // StateView included, is down, so the bus holds the subscription back and asks again rather than ending it on a fault
  private recheck(caller: Caller, topic: string): 'allow' | 'refuse' | 'down' {
    const asker: Asker = { caller, onBehalf: undefined, action: 'events.subscribe' }
    const scope: Scope = frozen({ topics: [topic] })
    for (const stage of ['raw', 'canonical'] as const) {
      const refused = this.decideFor(asker, stage, 'events.subscribe', scope, false)
      if (refused === null) continue
      const none = refused.code === 'starting' || refused.code === 'policy-down' || refused.code === 'stale'
      return none ? 'down' : 'refuse'
    }
    return 'allow'
  }

  private async serve(pending: Pending, served: Served | undefined, args: unknown): Promise<void> {
    if (served === undefined) return this.finish(pending, no('unavailable'))
    let result: unknown
    try {
      result = await served(this.callOf(pending, args))
    } catch (err) {
      return this.thrown(pending, null, 'perform', err)
    }
    this.result(pending, null, result)
  }

  // 6 route to a provider, then 7 prepare, 8 decide, 9 guard and 10 perform. The provider's lock, held from prepare,
  // goes back through release when the call stops before perform
  private async provide(pending: Pending, id: string, args: unknown, kind: Kind): Promise<void> {
    const info = this.info(id)
    if (info?.state === 'starting') return this.finish(pending, no('starting'))
    const provider = info?.state === 'ready' ? this.holder(() => this.options.providers(id)) : null
    if (provider === null) return this.finish(pending, no(this.down('unavailable')))
    const call = this.callOf(pending, args)
    // The provider's own handle may name this call as the parent of its sub-calls
    const host = this.ways.get(keyOf({ kind: 'plugin', id, half: 'host', incarnation: info!.incarnation }))
    if (host?.open) {
      host.delivered.set(pending.callId, pending)
      pending.host = host
    }

    let given: unknown
    try {
      given = await provider.prepare(call)
    } catch (err) {
      return this.thrown(pending, id, 'prepare', err)
    }
    const prepared = preparedIn(given)
    const release = () => {
      if (prepared === null) return
      try {
        provider.release?.(call, prepared)
      } catch {}
    }
    if (pending.done) return release()
    if (prepared === null) return this.finish(pending, { ok: false, ...(refusalIn(given) ?? { code: 'failed' }) })
    pending.scope = prepared.scope

    // Nothing awaits from here to perform, and perform gets the frozen copy the gate and the guards judge, never the
    // object prepare gave, which could answer another path when read again
    if (kind.kind === 'power') {
      const refused = this.judge(pending, 'canonical', kind.capability, prepared.scope)
      if (refused !== null) {
        release()
        return this.finish(pending, { ok: false, ...refused })
      }
    }
    const guarded = this.guard(pending, prepared)
    if (guarded !== null) {
      release()
      return this.finish(pending, no(guarded))
    }
    // A gate or a guard that ran past the deadline leaves the call no time to act in
    if (this.clock() >= pending.due) {
      release()
      return this.stop(pending, 'timeout')
    }

    let result: unknown
    try {
      result = await provider.perform(call, prepared)
    } catch (err) {
      return this.thrown(pending, id, 'perform', err)
    }
    this.result(pending, id, result)
  }

  // 9 guard: every expected guard on the action, in core/api's order, unless the human switched it off. A GuardCall
  // carries no arguments. The answer is timed once it returns and a late one counts as guard-down
  private guard(pending: Pending, prepared: Prepared): RefusalCode | null {
    if (!isOne(guardableActions, pending.action)) return null
    for (const id of this.guardsFor(pending.action)) {
      const state = this.slot(id)
      if (state === 'off') continue
      if (state === 'starting') return 'starting'
      const guard = state === 'on' ? this.holder(() => this.options.guards(id)) : null
      if (guard === null) return this.down('guard-down')
      const call: GuardCall = frozen({
        callId: pending.callId, caller: pending.caller,
        ...(pending.onBehalf !== undefined ? { onBehalf: pending.onBehalf } : {}),
        action: pending.action, scope: prepared.scope,
        ...(prepared.baseVersion !== undefined ? { baseVersion: prepared.baseVersion } : {}),
      })
      const asked = this.clock()
      let answer: unknown
      try {
        answer = guard.check(call)
      } catch (err) {
        this.fault(id, 'guard')
        this.debugOf(pending, id, err)
        return 'guard-down'
      }
      if (this.clock() - asked > this.limits.of(id, 'guardAnswerMs')) {
        this.fault(id, 'guard-late')
        return 'guard-down'
      }
      if (answer === 'deny') return 'guard-refused'
      if (answer !== 'allow') return 'guard-down'
    }
    return null
  }

  // 6 route to a plugin's declared <target>.<name>, then 8 decide and 10 perform by the callee. Only a caller that
  // passed precheck learns here whether the target is there, starting or declares the action
  private deliver(pending: Pending, target: Extract<Target, { kind: 'plugin' }>, args: unknown, kind: Kind): void {
    const info = this.info(target.target)
    if (info?.state === 'starting') return this.finish(pending, no('starting'))
    // Calls to an unresponsive plugin time out at once
    if (info?.state === 'unresponsive') return this.finish(pending, no('timeout'))
    if (info === null || info.state !== 'ready') return this.finish(pending, no('unavailable'))
    const declared = Object.hasOwn(info.actions, target.name) ? info.actions[target.name] : undefined
    if (typeof declared !== 'object' || declared === null) return this.finish(pending, no('not-found'))
    const { caller } = pending
    const own = caller.kind === 'plugin' && caller.id === target.target
    const from = declared.from
    if (!own && from !== undefined && !(caller.kind === 'plugin' && Array.isArray(from) && from.includes(caller.id))) {
      return this.finish(pending, no('not-granted'))
    }
    const callee = this.ways.get(keyOf({ kind: 'plugin', id: target.target, half: info.serves, incarnation: info.incarnation }))
    if (callee === undefined || !callee.open || callee.send === null) return this.finish(pending, no('unavailable'))
    if (kind.kind === 'power') {
      const refused = this.judge(pending, 'canonical', kind.capability, kind.scope)
      if (refused !== null) return this.finish(pending, { ok: false, ...refused })
    }
    if (this.clock() >= pending.due) return this.stop(pending, 'timeout')
    pending.callee = callee
    callee.delivered.set(pending.callId, pending)
    callee.send({
      v: VERSION, kind: 'call', callId: pending.callId, caller: pending.caller, action: pending.action, args,
      deadline: pending.deadline, ...(pending.onBehalf !== undefined ? { onBehalf: pending.onBehalf } : {}),
    })
  }

  // A callee's answer matches only a call delivered on this same way, so a reply on another port finds nothing
  private answered(way: Way, message: unknown): void {
    const parsed = answerSchema.safeParse(message)
    const callId = parsed.success ? parsed.data.callId : field(message, 'callId')
    const pending = typeof callId === 'string' ? way.delivered.get(callId) : undefined
    if (pending === undefined || pending.done || pending.callee !== way) return
    if (!parsed.success) return this.finish(pending, no('failed'))
    // A plugin answers for itself, so a code that describes the core's state reaches the caller as failed
    if (!parsed.data.ok) {
      const { code, reason } = parsed.data.refusal
      if (!isOne(calleeRefusalCodes, code)) return this.finish(pending, no('failed'))
      return this.finish(pending, { ok: false, code, ...(reason === 'too-large' ? { reason } : {}) })
    }
    this.result(pending, way.plugin, parsed.data.result)
  }

  // A cancel names a call this way made. Its sub-calls are cancelled with it and their late replies dropped
  private cancelled(way: Way, message: unknown): void {
    const parsed = cancelSchema.safeParse(message)
    if (!parsed.success) return
    const pending = way.made.get(parsed.data.id)
    if (pending !== undefined) this.stop(pending, 'stopped')
  }

  // Ends a call early with its whole tree of sub-calls. Each callee is told, so its answer is no longer read
  private stop(pending: Pending, code: RefusalCode): void {
    if (pending.done) return
    for (const child of [...pending.children]) this.stop(child, code)
    if (pending.callee?.open) pending.callee.send?.({ v: VERSION, kind: 'cancel', callId: pending.callId })
    this.finish(pending, no(code))
  }

  // 10 perform's result, within the cap of the plugin that made it, past which the call fails with too-large
  private result(pending: Pending, producer: string | null, result: unknown): void {
    if (pending.done) return
    const measured = measurePlain(result, this.limits.of(producer, 'resultBytes'))
    if (!measured.ok) return this.finish(pending, no('failed', measured.tooLarge ? 'too-large' : undefined))
    this.finish(pending, { ok: true, result })
  }

  // A thrown refusal keeps its code. Anything else is failed, with its text for debug only. plugin is the provider whose
  // step threw, null for a part the core serves
  private thrown(pending: Pending, plugin: string | null, step: 'prepare' | 'perform', err: unknown): void {
    if (pending.done) return
    const refused = refusalIn(err)
    if (refused !== null) return this.finish(pending, { ok: false, ...refused })
    this.debugOf(pending, plugin, err)
    if (plugin !== null) this.fault(plugin, step)
    this.finish(pending, no('failed'))
  }

  // Every call ends here once. The reply never waits on the record. Its live sub-calls stop with it, so none still waits
  // on a callee after the call answers. What a callee already did stays done. A callee that keeps working after it
  // answers makes its own calls
  private finish(pending: Pending, outcome: Outcome): void {
    if (pending.done) return
    pending.done = true
    for (const child of [...pending.children]) this.stop(child, 'stopped')
    if (pending.timer !== null) clearTimeout(pending.timer)
    for (const [principal] of pending.charged) {
      const load = this.inflight.get(principal)
      if (load === undefined) continue
      load.calls--
      load.bytes -= pending.bytes
      if (load.calls <= 0) this.inflight.delete(principal)
    }
    pending.way.made.delete(pending.id)
    pending.parent?.children.delete(pending)
    pending.callee?.delivered.delete(pending.callId)
    pending.host?.delivered.delete(pending.callId)
    if (pending.way.open) {
      const head = { v: VERSION, kind: 'reply', id: pending.id, callId: pending.callId }
      pending.answer(outcome.ok
        ? { ...head, ok: true, result: outcome.result }
        : { ...head, ok: false, refusal: this.refusalOf(pending.action, outcome) })
    }
    // 11 record
    const code = outcome.ok ? null : outcome.code
    this.recordCall({
      at: pending.started, caller: pending.caller,
      ...(pending.onBehalf !== undefined ? { onBehalf: pending.onBehalf } : {}),
      root: pending.root.caller, action: pending.action,
      ...(pending.scope !== undefined ? { scope: pending.scope } : {}),
      code, ms: this.now() - pending.started, gate: pending.gate,
    }, pending.coalesce || code !== null)
  }

  // A call refused before the ceiling took it, answered when its id could be read. Its record names onBehalf and the
  // root of a live parent once the envelope parsed
  private early(way: Way, answer: Send, callId: string, about: About, refused: No, started: number): void {
    if (about.id !== null && way.open) {
      answer({ v: VERSION, kind: 'reply', id: about.id, callId, ok: false, refusal: this.refusalOf(about.action, refused) })
    }
    this.recordCall({
      at: started, caller: way.caller, ...(about.onBehalf !== undefined ? { onBehalf: about.onBehalf } : {}),
      root: about.parent?.root.caller ?? way.caller, action: about.action, code: refused.code, ms: this.now() - started,
      gate: this.slot('gate'),
    }, true)
  }

  private refusalOf(action: string, refused: No): Refusal {
    return {
      code: refused.code,
      action,
      ...(refused.reason !== undefined ? { reason: refused.reason } : {}),
      ...(refused.request !== undefined ? { request: refused.request } : {}),
    }
  }

  // One audit record per call while the log is on or starting. Nothing while recording is off. A log that went down
  // or was switched off loses what the queue held, which is counted in a floor record. During shutdown the log stops
  // last and reads failed then, so records keep queueing and close counts what is left
  private recordCall(record: Parameters<AuditQueue['push']>[0], coalesce: boolean): void {
    if (this.muted()) return
    const log = this.slot('log')
    if (log !== 'on' && log !== 'starting' && !this.shutting) {
      const held = this.queue.clear()
      if (held > 0) this.lane.write('audit.dropped', { count: held, why: 'log-down' })
      return
    }
    if (!this.queue.push(record, coalesce, this.now())) this.coalesced.hit('audit.dropped', { why: 'full' })
  }

  private callOf(pending: Pending, args: unknown): Call {
    return frozen({
      callId: pending.callId, caller: pending.caller,
      ...(pending.onBehalf !== undefined ? { onBehalf: pending.onBehalf } : {}),
      ...(pending.parent !== null ? { parent: pending.parent.callId } : {}),
      action: pending.action, args, deadline: pending.deadline,
    })
  }

  private fault(plugin: string, step: string): void {
    this.coalesced.hit('fault', { plugin, step })
  }

  // plugin is whose code threw, so the text can go to that plugin's own debug and not the caller's
  private debugOf(asker: Asker, plugin: string | null, err: unknown): void {
    try {
      const text = err instanceof Error ? err.message : String(err)
      this.options.debug?.({ plugin, caller: asker.caller, action: asker.action, text })
    } catch {}
  }

  // The seams are later parts of the core and a throw there must not open anything: a slot that can't be read is
  // failed, a plugin that can't be read is absent
  private slot(id: string): SlotState {
    try {
      const state = this.options.loader.slot(id)
      return isOne(slotStates, state) ? state : 'failed'
    } catch {
      return 'failed'
    }
  }

  private info(id: string): PluginInfo | null {
    try {
      const info = this.options.loader.plugin(id)
      return info !== null && typeof info === 'object' && isOne(pluginStates, info.state) ? info : null
    } catch {
      return null
    }
  }

  private view(): number | null {
    try {
      const view = this.options.loader.view()
      return Number.isSafeInteger(view) ? view : null
    } catch {
      return null
    }
  }

  private muted(): boolean {
    try {
      return this.options.loader.recordNothing() === true
    } catch {
      return false
    }
  }

  private holder<T>(get: () => T | null): T | null {
    try {
      return get() ?? null
    } catch {
      return null
    }
  }
}
