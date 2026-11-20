import { createHash, randomBytes } from 'node:crypto'
import { coreActions, ends, eventActions, LIST_PAGE, providerActions, type CoreAction, type ProviderAction } from '../../api/actions.ts'
import { capabilityTypes, scopedUiTypes, type CapabilityType } from '../../api/capabilities.ts'
import {
  ack as ackSchema, agentLabel, answer as answerSchema, caller as callerSchema, cancel as cancelSchema, kindOf, reasonCodes,
  calleeRefusalCodes, refusalCodes, callEnvelope, token, VERSION, type Caller, type ReasonCode, type Refusal, type RefusalCode,
} from '../../api/envelope.ts'
import { MAX_TIMER_MS, type LimitName } from '../../api/limits.ts'
import {
  coreNamespaces, guardableActions, guards as expectedGuards, providers as providerIds, qualifiedName, type GuardableAction,
} from '../../api/ids.ts'
import { isDotName } from '../../api/names.ts'
import { frozen, measurePlain } from '../../api/plain.ts'
import { pathProblem } from '../../api/scope.ts'
import { spaceOf } from '../../api/storage.ts'
import {
  agentDoor, agentHost, agentOwn, pluginStates, policyJobStates, type Access, type Call, type Gate, type GuardCall, type Prepared,
  type Scope, type PolicyJobState,
} from '../../api/policy-jobs.ts'
import type { Field } from '../../lib/event-log.ts'
import { Bus, type Paths } from './bus.ts'
import { Limits } from './limits.ts'
import type { CarrierOptions, PluginInfo, Port, Served } from './header.ts'
import type { Admitted, Charged, Counted, Held } from '../flood-control/header.ts'
import type { CallRecord, Join, Recording } from '../recording/header.ts'

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
  // What flood control counts the way's messages by, one object for the way's life
  counted: Counted
  // Calls this way made, by the caller's own id
  made: Map<number, Pending>
  // Calls delivered to this way, by call id. Replies, parents and filterReadable look only here
  delivered: Map<string, Pending>
}

type Root = { principal: string, plugin: string | null, caller: Caller }

// A path with a dot segment names no note, whatever the gate's state: a plugin wrote it or kept it from a build before
// dot names were refused
const dotted = (path: string) => path.split('/').some(isDotName)

type Pending = {
  callId: string
  id: number
  way: Way
  answer: Send
  caller: Caller
  // The parent's for a sub-call, the caller's own text otherwise
  onBehalf: string | undefined
  // The agent the call is judged for, inherited from the door's call down the chain
  agent: string | undefined
  // The agent its sub-calls act for: the label of the door's own call, an agent's call's agent
  lends: string | undefined
  action: string
  parent: Pending | null
  root: Root
  depth: number
  deadline: number
  // The deadline on the clock no change of the wall clock moves. The steps check it before they hand a call on, since
  // a gate or a guard can run past it before the timer gets a turn
  due: number
  // Gives the call's room back to the flood control that took it, null when none did
  release: (() => void) | null
  children: Set<Pending>
  callee: Way | null
  timer: ReturnType<typeof setTimeout> | null
  done: boolean
  started: number
  gate: PolicyJobState
  scope: Scope | undefined
  // The paths of a second ask the gate or a guard refused after the last one let on, which a call that ends refused
  // records in place of scope
  refusedScope: Scope | undefined
  coalesce: boolean
  // How far a throttled filterReadable for this call got, so the next try goes on from there
  filtering: Filtering | null
}

// The paths by their hash, the gate and grants snapshot the answers came from, how many were asked about and the indexes kept
type Filtering = { hash: string, gate: object, view: number | null, asked: number, kept: number[] }

const hashOf = (paths: readonly string[]) => createHash('sha256').update(JSON.stringify(paths)).digest('hex')

type Target =
  | { kind: 'core', spec: CoreAction }
  | { kind: 'events', action: string }
  | { kind: 'served', namespace: 'ui' }
  | { kind: 'provider', provider: string, spec: ProviderAction }
  | { kind: 'plugin', target: string, name: string }

// also is a provider action's second requirement: its capability over the paths at these places in the scope
type Kind =
  | { kind: 'core' | 'served' | 'free' }
  | { kind: 'power', capability: CapabilityType, scope: Scope, also?: { capability: CapabilityType, at: readonly number[] } }

type No = { code: RefusalCode, reason?: ReasonCode, request?: string }
type Outcome = { ok: true, result: unknown } | ({ ok: false } & No)

// What the audit record of a call names, read from the envelope once it parsed. parent is the live call it named, whose
// onBehalf a call under it records whatever its own envelope said
type About = { id: number | null, action: string, onBehalf: string | undefined, parent: Pending | null }

// Who the gate is asked for: a call, or a subscription the bus asks about again
type Asker = { caller: Caller, onBehalf: string | undefined, agent?: string | undefined, action: string }

type Shaped =
  | ({ ok: false, no: No } & About)
  | ({ ok: true, id: number, target: Target, args: unknown, bytes: number, agent: string | undefined, lends: string | undefined } & About)

const no = (code: RefusalCode, reason?: ReasonCode): Outcome => ({ ok: false, code, ...(reason ? { reason } : {}) })

// The core actions the trusted window may send inside its input delay, since they only read
const trustedReads: ReadonlySet<string> = new Set(['core.self', 'core.status', 'security.list', 'log.segments', 'log.verify'])

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

// A subscriber as a core record names it
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

// The canonical scope prepare gave, copied, so what the gate and the guards judge can't change under them. A provider
// canonicalises paths and nothing else: the access and the command come from the raw scope the carrier built, so a
// prepare can't turn a commit into a read or one command into another
function preparedIn(value: unknown, raw: Scope = {}): Prepared | null {
  const scope = field(value, 'scope')
  if (typeof scope !== 'object' || scope === null) return null
  const paths = field(scope, 'paths')
  const target = field(scope, 'target')
  const baseVersion = field(value, 'baseVersion')
  if (paths !== undefined && (!Array.isArray(paths) || !paths.every(path => typeof path === 'string'))) return null
  if (target !== undefined && typeof target !== 'string') return null
  if (baseVersion !== undefined && typeof baseVersion !== 'string') return null
  return frozen({
    scope: {
      ...(paths !== undefined ? { paths: [...paths] } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(raw.access !== undefined ? { access: raw.access } : {}),
      ...(raw.command !== undefined ? { command: [...raw.command] } : {}),
    },
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  })
}

// The one path every call and reply takes, with the floor rules in it. The caller always comes from the way in.
// Policy comes from the policy jobs it asks: the gate decides and the carrier enforces
export class Carrier {
  private readonly options: CarrierOptions
  private readonly now: () => number
  private readonly clock: () => number
  private readonly limits: Limits
  // Recording, none with no log
  private readonly recording: Recording | null
  private readonly ways = new Map<string, Way>()
  private readonly ports = new WeakSet<object>()
  // The gate's time filterReadable took in the current second for each caller of a live call, by principal
  private readonly filtered = new Map<string, { second: number, spent: number }>()
  private readonly guardsFor: (action: GuardableAction) => readonly string[]
  private readonly bus: Bus
  // The grants snapshot number core.security last went out for
  private announced: number | null | undefined = undefined
  private closed = false
  // Shutdown began: the plugins manager reports what it stops as failed, so a policy job, guard or provider that is down answers stopped
  private shutting = false

  constructor(options: CarrierOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.clock = options.clock ?? (() => performance.now())
    this.limits = new Limits(() => options.pluginsManager.limits())
    this.recording = options.recording
    this.guardsFor = options.guardsFor ?? (action => expectedGuards[action])
    this.bus = new Bus({
      state: () => this.busState(),
      canList: (caller, path) => this.listable(caller, path),
      recheck: (caller, topic) => this.recheck(caller, topic),
      limit: (plugin, name) => this.limits.of(plugin, name),
      // Coalesced, since a publisher's pace or a subscriber's own can make them
      // Shutdown takes the gate down on its way out, which is no failure, so the bus records nothing then
      dropped: (caller, why) => {
        if (!this.shutting) this.coalesced('events.dropped', { ...whoOf(caller), why })
      },
      // One record each, since a change of the gate or the grants makes them
      changed: (caller, change, topics) => {
        if (!this.shutting) this.recorded(recording => recording.coreRecord(`events.${change}`, { ...whoOf(caller), ...topicsOf(topics) }))
      },
    })
  }

  // For the plugins manager, before it records core.stopping. The six policy job states have no stopping, so from here a policy job, guard
  // or provider that is down, for whatever reason, answers stopped where it would answer policy-down, guard-down or
  // unavailable. A gate that throws or a guard that answers late still answers as a fault. The bus keeps applying the
  // gate to the end, since a publish or a subscribe asks again first. It records no change to the subscriptions it
  // holds. Audit records keep queueing and the flush after close writes them
  stopping(): void {
    this.shutting = true
  }

  // The answer for something that is down: what it is outside shutdown, stopped once shutdown began
  private down(code: 'policy-down' | 'guard-down' | 'unavailable'): RefusalCode {
    return this.shutting ? 'stopped' : code
  }

  // Recording saw the log's health change: windows read core.status again, which says whether the log takes appends
  status(): void {
    if (!this.closed && !this.shutting) this.bus.emit('core.status')
  }

  // hetu is about to quit, so windows that hear core.quitting can keep a draft within the grace main gives them
  quitting(): void {
    if (!this.closed) this.bus.emit('core.quitting')
  }

  // A core module's publish, as events.publish delivers one: <owner>.<topic> for a path. A path events.publish's shape
  // refuses reaches nobody, as no call checks it, and one with a dot segment reaches no subscriber whatever the gate's
  // state. The module names its own topics, so no manifest is read. No call carries it, so it makes no audit record of
  // an events.publish
  publishCore(owner: string, topic: string, path: string): void {
    if (this.closed || pathProblem(path) !== null || dotted(path)) return
    this.bus.publish(`${owner}.${topic}`, path)
  }

  // For the plugins manager, after it changed a policy job state, a plugin state or the grants snapshot. Once the gate's state or the
  // grants snapshot moved, the bus asks the gate again about every subscription it holds. Windows hear core.status, and
  // core.security once a new grants snapshot applied a security change. The first grants snapshot the carrier reads is where it
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

  // For the plugins manager: a planned stop or a revoked incarnation. Its subscriptions and credits go at once, calls delivered to
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

  // For the plugins manager: a lifecycle message (init, deps, stop or ping) down a half's own way. A way that is gone or was
  // never registered drops it. Nothing the core sends counts against the half's rate
  send(caller: Caller, message: unknown): void {
    const way = this.ways.get(keyOf(caller))
    if (way === undefined || !way.open || way.send === null) return
    way.send(message)
  }

  // For the plugins manager: a limit as the carrier enforces it for one plugin, so the plugins manager's start and stop
  // deadlines follow the same values
  limit(plugin: string, name: LimitName): number {
    return this.limits.of(plugin, name)
  }

  // The records of the calls it stops stay queued for the flush after close, then recording takes nothing more in. What
  // the log can't take by then is lost with the run and a count of it couldn't land either
  close(): void {
    this.closed = true
    for (const way of [...this.ways.values()]) this.end(way.caller)
    this.recorded(recording => recording.close())
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
      counted: Object.freeze({ plugin }),
      made: new Map(),
      delivered: new Map(),
    }
    this.ways.set(way.key, way)
    return way
  }

  // 1 bind: the caller is the way's. Every message counts against the way's rate before it is read
  private receive(way: Way, message: unknown, answer: Send): void {
    if (!way.open || this.closed) return
    // Everything main hears from a utility half counts as alive, noted before the rate so one dropped for it or one
    // that can't be read counts too. A worker's messages pass its relay first, which drops some unheard, so a worker
    // keeps the heartbeat alone
    if (way.via === 'port' && way.caller.kind === 'plugin' && way.caller.half === 'host' && this.info(way.caller.id)?.place === 'utility') {
      try {
        this.options.pluginsManager.heard(way.caller, 'alive')
      } catch {}
    }
    const verdict = this.admit(way)
    // Closing a window's way would lock the human out, so a window only ever drops
    if (verdict === 'flood' && way.via !== 'window') return this.flood(way)
    // One over the rate gets no reply
    if (verdict !== 'pass') return
    // A message that throws while it is read is dropped like one that can't be read
    try {
      const kind = kindOf(message)
      if (kind === 'call') void this.call(way, message, answer)
      else if (kind === 'reply') this.answered(way, message)
      else if (kind === 'cancel') this.cancelled(way, message)
      else if (kind === 'ack') this.acked(way, message)
      else if ((kind === 'ready' || kind === 'pong' || kind === 'stopped') && way.plugin !== null) {
        this.options.pluginsManager.heard(way.caller, kind)
      }
      // Anything else, another v and the kinds only the carrier sends included, is dropped unread
    } catch {}
  }

  // Flood control's verdict on one message, pass while it is off. A throw or an answer outside the list drops that one
  // message, so a broken count never lets one through
  private admit(way: Way): Admitted {
    const flood = this.holder(() => this.options.floodControl())
    const verdict = flood === null ? 'pass' : this.flooded('admit', () => flood.admit(way.counted))
    return verdict === 'pass' || verdict === 'flood' ? verdict : 'drop'
  }

  // A step of flood control, undefined with a fault recorded when it throws, which no answer of its is
  private flooded(step: string, run: () => unknown): unknown {
    try {
      return run()
    } catch {
      this.fault('flood-control', step)
      return undefined
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

  // Its subscriptions and credits go first, so nothing the plugins manager changes on hearing of the crash is sent to the dead
  // way. The plugins manager moves dependents to waiting before crashed returns. Then the calls the plugin held answer crashed,
  // the calls it made are given up and their callees told
  private dead(way: Way, reason: 'closed' | 'flood'): void {
    way.open = false
    if (this.ways.get(way.key) === way) this.ways.delete(way.key)
    this.bus.drop(way)
    try {
      this.options.pluginsManager.crashed(way.caller, reason)
    } catch {}
    for (const pending of [...way.delivered.values()]) this.stop(pending, 'crashed')
    for (const pending of [...way.made.values()]) this.stop(pending, 'crashed')
  }

  // Nothing escapes: a call no step could take is dropped and one in flight fails
  private async call(way: Way, message: unknown, answer: Send): Promise<void> {
    let pending: Pending | null = null
    // The room flood control charged, given back here when the call throws before it is in flight
    let release: (() => void) | null = null
    try {
      const started = this.now()
      const callId = newId()
      const shaped = this.shape(way, message)
      if (!shaped.ok) return this.early(way, answer, callId, shaped, shaped.no, started)
      const kind = this.floorOf(way, shaped.target, shaped.args, shaped.agent)
      if ('code' in kind) return this.early(way, answer, callId, shaped, kind, started)
      const charged = this.charge(way, shaped.parent, shaped.bytes)
      if (!('release' in charged)) return this.early(way, answer, callId, shaped, charged, started)
      release = charged.release
      pending = this.admitted(way, answer, callId, shaped, kind, started, release)
      await this.run(pending, shaped.target, shaped.args, kind)
    } catch (err) {
      if (pending === null) return release?.()
      this.debugOf(pending, null, err)
      this.finish(pending, no('failed'))
    }
  }

  // 2 shape: the strict envelope, args within the caller's cap, the schema of a core or provider action and a parent
  // that names a live call delivered on this same way. A call under a parent takes the parent's onBehalf and can't set
  // its own
  private shape(way: Way, message: unknown): Shaped {
    const parsed = callEnvelope.safeParse(message)
    if (!parsed.success) {
      return { ok: false, id: readId(message), action: readAction(message), onBehalf: undefined, parent: null, no: { code: 'invalid' } }
    }
    const { id, action, parent: parentId } = parsed.data
    // Looked up first so a refused call's record still names its root. A call past its due time is as good as over,
    // though its timer hasn't run yet
    const named = parentId === undefined ? null : way.delivered.get(parentId) ?? null
    const parent = named !== null && !named.done && this.clock() < named.due ? named : null
    const onBehalf = parent !== null ? parent.onBehalf : parsed.data.onBehalf
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
      if (parent === null || parsed.data.onBehalf !== undefined) return refuse('invalid')
      if (parent.depth + 1 > this.limits.of(way.plugin, 'parentDepth')) return refuse('invalid')
    }
    // A label is an agent's only down a chain that started at the door's own call with a label, the door known by the
    // way that call came on. The door's call is still mcp-http-handler's own. Any other call keeps a label as text that grants
    // nothing. A call from the door names the agent it is for in the agent label's form, so one with no label or another
    // is refused before mcp sees it
    const agent = parent?.lends
    const door = parent === null && action === agentDoor.action && this.isDoor(way)
    if (door && !agentLabel.safeParse(onBehalf).success) return refuse('invalid')
    // A label the human revoked is refused at the door with no word from mcp-http-handler, so a revoke holds while mcp-http-handler's token lives
    if (door && this.revoked(onBehalf as string)) return refuse('not-granted')
    return { ok: true, id, action, onBehalf, target, args, bytes: measured.bytes, parent, agent, lends: door ? onBehalf : agent }
  }

  // 3 floor: who may call a core action, security.* included, the trusted window held to core actions,
  // the agent host held to the door's calls past its own, an agent's chain held to the tool table and the free actions
  // that skip the gate. Never asks the gate
  private floorOf(way: Way, target: Target, args: unknown, agent: string | undefined): Kind | No {
    const { caller } = way
    const trusted = caller.kind === 'window' && caller.role === 'trusted'
    // The agent host reaches a provider but its own storage and a plugin but itself only for an agent whose call from
    // the door is live, so a plugin that reads for it can't read for no one
    const host = caller.kind === 'plugin' && caller.id === agentHost
    const beyond = target.kind === 'provider' ? !isOne(agentOwn, target.provider) : target.kind === 'plugin' && target.target !== agentHost
    if (host && beyond && agent === undefined) return { code: 'not-granted' }
    // A call for an agent from any plugin down the chain reaches its caller's own storage and cache and the provider
    // actions core/api's table marks as tools, whatever the agent or the caller holds. Marking an action in the table is
    // what opens it
    if (agent !== undefined && target.kind === 'provider' && target.spec.agent === undefined && !isOne(agentOwn, target.provider)) {
      return { code: 'not-granted' }
    }
    if (target.kind === 'core') {
      const { from } = target.spec
      const admitted = from === 'any'
        || (from === 'windows' && caller.kind === 'window')
        || (from === 'trusted' && trusted)
        || (from === 'http' && this.isDoor(way))
        // The agent host under a live call from the door, so the agent it asks for is that call's and no other
        || (from === 'agent' && host && agent !== undefined)
      // A from with no rule here refuses every caller
      return admitted ? { kind: 'core' } : { code: 'not-granted' }
    }
    if (target.kind === 'events') {
      // A subscription outlives the call it was made under and what it delivers is filtered for the subscriber alone,
      // so the agent host subscribes to no topic but its own, under an agent's call or not
      const kind = this.eventsFloor(caller, target.action, args)
      return host && 'kind' in kind && kind.kind === 'power' ? { code: 'not-granted' } : kind
    }
    // The trusted window holds core actions and the core topics only and never note content
    if (trusted) return { code: 'not-granted' }
    if (target.kind === 'served') return { kind: 'served' }
    if (target.kind === 'provider') {
      const { capability, scope, access, also } = target.spec
      if (capability === null) return { kind: 'free' }
      const paths = scope === 'path'
        ? [field(args, 'path') as string]
        : scope === 'paths' ? [...field(args, 'paths') as string[]] : scope === 'ends' ? ends.map(end => field(args, end) as string) : undefined
      // A command is canonical as written. access is the action's own, from core/api's table
      const command = scope === 'command' ? [...field(args, 'command') as string[]] : undefined
      return {
        kind: 'power',
        capability,
        scope: frozen({ ...(paths !== undefined ? { paths } : {}), ...(access !== undefined ? { access } : {}), ...(command !== undefined ? { command } : {}) }),
        ...(also !== undefined ? { also: frozen({ capability: also.capability, at: also.ends.map(end => ends.indexOf(end)) }) } : {}),
      }
    }
    // A plugin's own halves call each other freely
    if (caller.kind === 'plugin' && caller.id === target.target) return { kind: 'free' }
    return { kind: 'power', capability: 'plugin.call', scope: frozen({ target: target.target }) }
  }

  // mcp-http-handler's host half in its utility process: a way register made, so a port the plugins manager minted, bound to plugin mcp-http-handler's
  // host half, with mcp-http-handler placed utility as the plugins manager reads it now. A worker of mcp-http-handler matches the id, the way and the
  // place, so the half is named too. The incarnation is not compared: the plugins manager ends every way of an incarnation in
  // release before it mints the next, so no way of an older one is left to call
  private isDoor(way: Way): boolean {
    const { caller } = way
    const half = way.via === 'port' && caller.kind === 'plugin' && caller.id === 'mcp-http-handler' && caller.half === 'host'
    return half && this.info('mcp-http-handler')?.place === 'utility'
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

  // 4 ceiling: flood control's yes or no on the call's bytes, charged to the caller and to the root of its parent
  // links. With flood control off nothing is charged. A no is throttled. A throw, or an acquire of the wrong shape, fails
  // the call, as a provider's throw does
  private charge(way: Way, parent: Pending | null, bytes: number): { release: (() => void) | null } | No {
    const flood = this.holder(() => this.options.floodControl())
    if (flood === null) return { release: null }
    const root = parent?.root ?? way
    const charged = (one: Root | Way): Charged => Object.freeze({ principal: one.principal, plugin: one.plugin })
    const held = this.flooded('acquire', () => flood.acquire(charged(way), charged(root), bytes))
    if (held === null) return { code: 'throttled' }
    if (typeof held !== 'object') return { code: 'failed' }
    return { release: () => this.flooded('release', () => flood.release(held as Held)) }
  }

  // The call in flight once the ceiling took it, its deadline shrinking along parent
  private admitted(
    way: Way, answer: Send, callId: string, shaped: Extract<Shaped, { ok: true }>, kind: Kind, started: number, release: (() => void) | null,
  ): Pending {
    const { parent, target } = shaped
    const root: Root = parent?.root ?? { principal: way.principal, plugin: way.plugin, caller: way.caller }
    // Never past the longest delay a timer takes, so a raised deadline can't fire at once and stays a safe integer
    const ownDeadline = started + Math.min(this.limits.of(way.plugin, 'callDeadlineMs'), MAX_TIMER_MS)
    // Shrinks along parent, so no sub-call outlives the call it serves
    const deadline = Math.min(ownDeadline, parent?.deadline ?? ownDeadline)
    const left = Math.max(0, deadline - this.now())
    const pending: Pending = {
      callId, id: shaped.id, way, answer, caller: way.caller, onBehalf: shaped.onBehalf, agent: shaped.agent, lends: shaped.lends,
      action: shaped.action, parent, root, depth: (parent?.depth ?? 0) + 1, deadline, due: this.clock() + left, release,
      children: new Set(), callee: null, timer: null, done: false, started, gate: this.policyJob('gate'),
      // A path is the caller's own text until prepare gives the canonical one, so a call refused before that records
      // no path. A plugin call's target is already the plugin's id
      scope: kind.kind === 'power' && kind.scope.paths === undefined ? kind.scope : undefined,
      refusedScope: undefined,
      coalesce: target.kind === 'core'
        ? !shaped.action.startsWith('security.')
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
    // A call for an agent goes on only while the gate is on, a free one or a core action with nothing to judge included,
    // so no call for an agent runs while the agent's grant can't be judged. The door's own call lends its label, so it is
    // refused here before mcp sees any of the agent's request. A call with power is judged at decideFor too
    if (pending.lends !== undefined) {
      const open = this.gateOpen(pending.lends)
      if (open !== 'decide') return this.finish(pending, no(open as RefusalCode))
    }
    // A subscribe keeps its own precheck, since one made while the gate is down stands rather than being refused
    if (target.kind === 'events') return this.events(pending, args, kind)
    // 5 precheck, for calls with power only
    if (kind.kind === 'power') {
      const refused = this.judgeAll(pending, 'raw', kind, kind.scope)
      if (refused !== null) return this.finish(pending, { ok: false, ...refused })
    }
    // 6 route, then 7 to 10 by the route
    if (target.kind === 'core') return this.coreAction(pending, args)
    if (target.kind === 'served') return this.serve(pending, this.options.served?.[target.namespace], args)
    if (target.kind === 'provider') return this.provide(pending, target.provider, args, kind)
    return this.deliver(pending, target, args, kind)
  }

  // The gate policy job's state: decide asks the gate, pass skips it and a code refuses. With the gate off by the human a
  // call with power passes while its record can still land and passes unrecorded once the human turned recording off.
  // A call for an agent never passes: with the gate off nothing judges the agent's own grant, so it answers as a gate
  // that is down. Once shutdown began a call for an agent answers stopped whatever the gate's state, so the door's call
  // during a shutdown answers the same with the gate on as with it off
  private gateOpen(agent?: string): 'decide' | 'pass' | RefusalCode {
    if (agent !== undefined && this.shutting) return 'stopped'
    const gate = this.policyJob('gate')
    if (gate === 'on') return 'decide'
    if (gate === 'starting') return 'starting'
    if (gate !== 'off' || agent !== undefined) return this.down('policy-down')
    if (!this.logFailing()) return 'pass'
    return this.down('policy-down')
  }

  // 5 precheck at the raw stage and 8 decide at the canonical one. Only an exact allow: true on the current grants snapshot
  // lets a call on. A throw refuses this one call and is recorded. An ask, at the canonical stage only, becomes
  // needs-confirm with the request the prompt holds, or not-granted with no prompt raised when prompt is false
  private judge(pending: Pending, stage: Access['stage'], capability: CapabilityType, scope: Scope, prompt = true): No | null {
    if (stage === 'raw') pending.gate = this.policyJob('gate')
    return this.decideFor(pending, stage, capability, scope, prompt)
  }

  // A call's requirement and then its second one, when its action has one, on the paths at the places it names. A
  // scope that lacks one of those places fails, since the second requirement would judge nothing
  private judgeAll(pending: Pending, stage: Access['stage'], kind: Extract<Kind, { kind: 'power' }>, scope: Scope, prompt = true): No | null {
    const refused = this.judge(pending, stage, kind.capability, scope, prompt)
    if (refused !== null || kind.also === undefined) return refused
    const paths = kind.also.at.map(at => scope.paths?.[at])
    if (paths.length === 0 || !paths.every(path => typeof path === 'string')) return { code: 'failed' }
    return this.judge(pending, stage, kind.also.capability, frozen({ paths }), prompt)
  }

  // The gate's answer for a call or for a subscription the bus asks about again. An ask raises the prompt for both,
  // since a live subscription is its item in use. Every judgement of a call comes here, so a call for an agent is
  // judged against the agent's own grant beside the caller's at each one and passes at none while the gate isn't on
  private decideFor(asker: Asker, stage: Access['stage'], capability: CapabilityType, scope: Scope, prompt = true): No | null {
    const open = this.gateOpen(asker.agent)
    if (open === 'pass') return null
    if (open !== 'decide') return { code: open }
    const gate = this.holder(() => this.options.gate())
    if (gate === null) return { code: this.down('policy-down') }
    const access: Access = frozen({
      stage, caller: asker.caller, ...(asker.onBehalf !== undefined ? { onBehalf: asker.onBehalf } : {}),
      ...(asker.agent !== undefined ? { agent: asker.agent } : {}), action: asker.action, capability, scope,
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
      if (!prompt) return { code: 'not-granted' }
      const request = this.raise(ask, access)
      if (typeof request === 'string') return { code: 'needs-confirm', request }
      return request ?? { code: 'not-granted' }
    }
    return { code: allow === false && code === 'switched-off' ? 'switched-off' : 'not-granted' }
  }

  // A request id in the grammar, or one of the refusals the prompt may give. Anything else refuses not-granted
  private raise(ask: string, access: Access): string | No | null {
    try {
      const request = this.options.asks?.raise(ask, access)
      if (token.safeParse(request).success) return request as string
      if (request === null || typeof request !== 'object') return null
      if (request.code === 'throttled') return { code: 'throttled' }
      if (request.code === 'not-granted') return request.reason === 'declined' ? { code: 'not-granted', reason: 'declined' } : { code: 'not-granted' }
      return null
    } catch {
      return null
    }
  }

  // Core actions: the carrier serves its own and hands the rest to the plugins manager and the runtime
  private async coreAction(pending: Pending, args: unknown): Promise<void> {
    if (pending.action === 'core.self') return this.finish(pending, { ok: true, result: pending.caller })
    if (pending.action === 'core.filterReadable') return this.finish(pending, this.filterReadable(pending.way, args))
    if (pending.action === 'editor.reach') return this.finish(pending, this.reach(args))
    if (pending.action === 'log.segments' || pending.action === 'log.verify') {
      const { recording } = this
      return this.serve(pending, recording === null ? undefined : call => recording.serve(call), args)
    }
    // Anything the trusted window sends inside its input delay counts for nothing, whatever the page did: a Confirm, and
    // with confirmOff on a request that applies at once. Its reads answer
    const { caller } = pending
    if (caller.kind === 'window' && caller.role === 'trusted' && !trustedReads.has(pending.action) && !this.armed(caller)) {
      return this.finish(pending, no('throttled'))
    }
    // Coalesced by reason with the counts added up, so mcp-http-handler calling at its whole rate still leaves two records a reason
    // a second
    if (pending.action === 'core.agentRefused') {
      this.coalesced('http.refused', { reason: field(args, 'reason') as string }, undefined, field(args, 'count') as number)
      return this.finish(pending, { ok: true, result: null })
    }
    return this.serve(pending, this.options.core, args)
  }

  // What a plugin may do with one note through the editor bridge, which the drawer asks before it serves the plugin
  // anything about the note: read it, write it, list its name and the ui items it holds, from the gate with the plugin as the caller at
  // the canonical stage. A write whose item still asks at first use counts as none, since the bridge raises no prompt.
  // Everything with the gate off while a record can still land, policy-down while it starts or is down, as for any call
  private reach(args: unknown): Outcome {
    const plugin = field(args, 'plugin') as string
    const path = field(args, 'path') as string | undefined
    const state = this.policyJob('gate')
    if (state === 'off') {
      const open = this.gateOpen()
      if (open !== 'pass') return no(open as RefusalCode)
      const verbs = capabilityTypes.filter(type => type.startsWith('ui.') && !isOne(scopedUiTypes, type))
      const any = path !== undefined && !dotted(path)
      return { ok: true, result: { read: any, edit: any, uiRead: any, list: any, verbs } }
    }
    const gate = state === 'on' ? this.holder(() => this.options.gate()) : null
    if (gate === null) return no(this.down('policy-down'))
    const caller: Caller = frozen({ kind: 'plugin', id: plugin, half: 'worker', incarnation: 1 })
    try {
      const held = gate.verbs(plugin, 'editor')
      const verbs = Array.isArray(held) ? held.filter(verb => typeof verb === 'string') : []
      // No note the human opened has a path with a dot segment, so the gate isn't asked about one
      if (path === undefined || dotted(path)) return { ok: true, result: { read: false, edit: false, uiRead: false, list: false, verbs } }
      const read = gate.canRead(caller, path) === true
      const list = gate.canList(caller, path) === true
      // An edit through the editor needs ui.edit on the note, never luoshu.write. ui.read is a read the drawer serves
      // only for a note the human opened
      const allows = (action: string, capability: 'ui.edit' | 'ui.read') => {
        const decision = gate.decide(frozen({ stage: 'canonical', caller, action, capability, scope: frozen({ paths: [path] }) }))
        return 'allow' in decision && decision.allow === true
      }
      const edit = allows('editor.edit', 'ui.edit')
      const uiRead = allows('editor.read', 'ui.read')
      return { ok: true, result: { read, edit, uiRead, list, verbs } }
    } catch {
      this.fault('gate', 'reach')
      return no('policy-down')
    }
  }

  // Only during a live call delivered on this way. The paths the callee may read itself that the call's own caller may
  // read too, every path with the gate off and policy-down while the gate is starting or failed. Never one with a dot
  // segment, which the gate isn't asked about. One message asks the
  // gate up to twice per path, synchronously in main, and scopes shaped for the matcher's worst case make each ask
  // slow. So the gate's time counts against the live call's caller, filterMsPerSecond each second, and one that floods
  // a plugin with calls spends only its own. Past it the call answers throttled and the live call keeps how far it got,
  // so the next try goes on from there and any call finishes within its deadline. That progress is dropped once the
  // gate or the grants snapshot changed, so no answer from before a narrowing stands
  // For a live call that acts for an agent, the paths the agent may read too, and none at all while the gate isn't on.
  // The door's own call names mcp-http-handler as its caller, which reads nothing and passes the answer on to the agent, so there the
  // agent's grant stands in for the caller's
  private filterReadable(way: Way, args: unknown): Outcome {
    const live = way.delivered.get(field(args, 'call') as string)
    const paths = field(args, 'paths') as string[]
    if (live === undefined || live.done) return no('invalid')
    const agent = live.lends
    const door = agent !== undefined && live.agent === undefined
    if (agent !== undefined) {
      const open = this.gateOpen(agent)
      if (open !== 'decide') return no(open as RefusalCode)
    }
    const state = this.policyJob('gate')
    if (state === 'off') return { ok: true, result: paths.filter(path => !dotted(path)) }
    const gate = state === 'on' ? this.holder(() => this.options.gate()) : null
    if (gate === null) return no(this.down('policy-down'))
    const budget = this.limits.of(live.way.plugin, 'filterMsPerSecond')
    const spent = this.secondOf(live.way.principal)
    const started = this.clock()
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
        const kept = !dotted(path) && gate.canRead(way.caller, path, agent) === true && (door || gate.canRead(live.caller, path) === true)
        if (kept) progress.kept.push(progress.asked)
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
      const path = field(args, 'path') as string | undefined
      // One with a dot segment reaches no subscriber whatever the gate's state, as one the gate lets no one list
      if (path === undefined || !dotted(path)) this.bus.publish(field(args, 'topic') as string, path)
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
    const down = gated.length > 0 && this.policyJob('gate') !== 'off' && !this.askable()
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
      this.coalesced('events.waiting', { ...whoOf(way.caller), ...topicsOf(standing) }, { by: whoOf(way.caller), join: joinTopics })
    }
    this.finish(pending, { ok: true, result: { standing } })
  }

  // An ack names the way's own events, so a subscriber frees no credits but its own
  private acked(way: Way, message: unknown): void {
    const parsed = ackSchema.safeParse(message)
    if (parsed.success) this.bus.ack(way, parsed.data.seq)
  }

  // What the bus delivers paths under. The key holds everything a subscription the gate holds depends on, so the bus
  // asks again whenever it moves. canList is true with the gate off by the human whatever the log, since deliveries
  // are never logged, as filterReadable passes every path then. A gate that can't be asked is down
  private busState(): { key: string, paths: Paths, view: number | null } {
    const state = this.policyJob('gate')
    const view = this.view()
    const paths: Paths = state === 'off' ? 'all' : this.askable() ? 'ask' : 'none'
    return { key: `${state} ${paths} ${view}`, paths, view }
  }

  // The gate can be asked: its policy job is on, there is a holder and the grants snapshot can be read. Otherwise every answer
  // would be policy-down, so the bus holds paths back and a subscribe stands
  private askable(): boolean {
    return this.policyJob('gate') === 'on' && this.holder(() => this.options.gate()) !== null && this.view() !== null
  }

  // canList on every delivery of a path and on each name a listing found: only an exact true counts and a throw is a no
  // that is recorded
  private listable(caller: Caller, path: string): boolean {
    const gate = this.holder(() => this.options.gate())
    if (gate === null) return false
    try {
      return gate.canList(caller, path) === true
    } catch {
      this.fault('gate', 'canList')
      return false
    }
  }

  // A subscription asked about again, at both stages as a subscribe is. No answer, a throw or one on an older
  // grants snapshot included, is down, so the bus holds the subscription back and asks again rather than ending it on a fault.
  // An ask is the item's first use: the prompt holds a request for the human, or can't for now, and the subscription
  // waits for the Confirm. A declined ask refuses
  private recheck(caller: Caller, topic: string): 'allow' | 'refuse' | 'down' | 'ask' {
    const asker: Asker = { caller, onBehalf: undefined, action: 'events.subscribe' }
    const scope: Scope = frozen({ topics: [topic] })
    for (const stage of ['raw', 'canonical'] as const) {
      const refused = this.decideFor(asker, stage, 'events.subscribe', scope)
      if (refused === null) continue
      if (refused.code === 'needs-confirm' || refused.code === 'throttled') return 'ask'
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

  // 6 route to a provider, then 7 prepare, 8 decide, 9 guard and 10 perform. The provider is the core module serving
  // the namespace, null while that module is off or failed, which answers unavailable. The provider's lock, held from
  // prepare, goes back through release when the call stops before perform
  private async provide(pending: Pending, id: string, args: unknown, kind: Kind): Promise<void> {
    const listing = providerActions[pending.action]?.filter === 'list'
    const unlisted = listing ? this.listingRefused(pending) : null
    if (unlisted !== null) return this.finish(pending, no(unlisted))
    const provider = this.holder(() => this.options.providers(id))
    if (provider === null) return this.finish(pending, no(this.down('unavailable')))
    const lister = listing ? this.lister(pending) : null
    // Set once the gate and the guards let the call on, so a judge asked before then answers no
    let judged: Prepared | null = null
    const judge = kind.kind === 'power' ? (paths: readonly string[]) => this.judgeAgain(pending, kind, judged, paths) : undefined
    const call = frozen({
      ...this.callOf(pending, args), ...(lister === null ? {} : { canList: lister.canList }), ...(judge === undefined ? {} : { judge }),
    })
    let given: unknown
    try {
      given = await provider.prepare(call)
    } catch (err) {
      return this.thrown(pending, id, 'prepare', err)
    }
    const prepared = preparedIn(given, kind.kind === 'power' ? kind.scope : undefined)
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
    const refused = this.judged(pending, kind, prepared, true)
    if (refused !== null) {
      release()
      return this.finish(pending, { ok: false, ...refused })
    }
    judged = prepared
    // A gate or a guard that ran past the deadline leaves the call no time to act in
    if (this.clock() >= pending.due) {
      release()
      return this.stop(pending, 'timeout')
    }

    let result: unknown
    try {
      result = await provider.perform(call, prepared)
    } catch (err) {
      if (id === 'storage' && refusalIn(err)?.code === 'tampered') this.tampered(pending, args)
      lister?.charge()
      return this.thrown(pending, id, 'perform', err)
    }
    if (lister !== null) {
      lister.charge()
      return this.finish(pending, this.listed(lister, result))
    }
    this.result(pending, id, result)
  }

  // 8 decide on a call with power and 9 guard, for the call's first judgement and for every second ask, so the two
  // can't judge a call differently. Each end the caller named stays one end, so the second requirement judges the end
  // it was asked about
  private judged(pending: Pending, kind: Kind, prepared: Prepared, prompt: boolean): No | null {
    if (kind.kind === 'power') {
      const reshaped = kind.also !== undefined && prepared.scope.paths?.length !== kind.scope.paths?.length
      const refused = reshaped ? { code: 'failed' as const } : this.judgeAll(pending, 'canonical', kind, prepared.scope, prompt)
      if (refused !== null) return refused
    }
    const guarded = this.guard(pending, prepared)
    return guarded === null ? null : { code: guarded }
  }

  // A provider's second ask, when a look at the disk after the first judgement reads a path otherwise: the paths it
  // would act on now, one for each path prepare gave, judged as the first were. Never once the call has ended. No prompt
  // is raised from here, so an item that still asks at first use answers not-granted. A call let on acts on these
  // paths, so its record names them. A call that ends refused after a refused one records the paths refused, with the
  // code the provider passes on, in place of the paths judged before. One that fails on its shape names nothing new
  private judgeAgain(pending: Pending, kind: Extract<Kind, { kind: 'power' }>, prepared: Prepared | null, paths: readonly string[]): No | null {
    if (prepared === null || pending.done) return { code: 'not-granted' }
    const given = prepared.scope.paths
    if (!Array.isArray(paths) || given === undefined || paths.length !== given.length || !paths.every(path => typeof path === 'string')) return { code: 'failed' }
    const now: Prepared = frozen({ ...prepared, scope: { ...prepared.scope, paths: [...paths] } })
    const refused = this.judged(pending, kind, now, false)
    if (refused !== null) {
      pending.refusedScope = now.scope
      return refused
    }
    pending.scope = now.scope
    pending.refusedScope = undefined
    return null
  }

  // 9 guard: every expected guard on the action, in core/api's order, unless the human switched it off. A GuardCall
  // carries no arguments. The answer is timed once it returns and a late one counts as guard-down
  private guard(pending: Pending, prepared: Prepared): RefusalCode | null {
    if (!isOne(guardableActions, pending.action)) return null
    for (const id of this.guardsFor(pending.action)) {
      const state = this.policyJob(id)
      if (state === 'off') continue
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

  // A stored key failed its hash line. The plugin decides what to do with it. A plugin can trigger this, so it is one
  // record per space each second, naming the first key and then the last with the count
  private tampered(pending: Pending, args: unknown): void {
    const space = spaceOf(pending.caller)
    const key = field(args, 'key')
    if (space === null || typeof key !== 'string') return
    this.coalesced('storage.tampered', { space, key }, { by: { space }, join: (_held, next) => next })
  }

  // What a listing's provider gets to filter with, and the charge for the whole listing. canList asks the gate for the
  // caller and the agent it acts for, every name passing with the gate off by the human and none for an agent then. A
  // throw counts as a no and fails the listing. The whole listing, the walk and the gate's time alike, counts against
  // the caller's second as filterReadable's does
  private lister(pending: Pending): { canList: (path: string) => boolean, threw: () => boolean, charge: () => void } {
    const off = this.policyJob('gate') === 'off'
    const gate = off ? null : this.holder(() => this.options.gate())
    const { agent } = pending
    let threw = false
    const started = this.clock()
    let charged = false
    return {
      canList: path => {
        if (dotted(path)) return false
        if (off) return agent === undefined
        if (gate === null || threw) return false
        try {
          return gate.canList(pending.caller, path, agent) === true
        } catch {
          threw = true
          return false
        }
      },
      threw: () => threw,
      charge: () => {
        if (charged) return
        charged = true
        this.secondOf(pending.way.principal).spent += this.clock() - started
      },
    }
  }

  // A listing's page as the provider gave it, checked again before the caller sees it: at most LIST_PAGE names, each
  // one the caller may list, and a next that is null or the page's last name. Anything else fails, so a provider that
  // filters wrongly leaks no name, not even as where the next page starts
  private listed(lister: { canList: (path: string) => boolean, threw: () => boolean }, result: unknown): Outcome {
    if (lister.threw()) {
      this.fault('gate', 'canList')
      return no('policy-down')
    }
    const paths = field(result, 'paths')
    const next = field(result, 'next')
    if (!Array.isArray(paths) || paths.length > LIST_PAGE || !paths.every(path => typeof path === 'string')) return no('failed')
    if (next !== null && next !== paths.at(-1)) return no('failed')
    if (!paths.every(path => lister.canList(path))) return no(lister.threw() ? 'policy-down' : 'failed')
    return { ok: true, result: { paths: [...paths], next } }
  }

  // Before a listing is made: refused while the gate can't be asked, and throttled once the caller spent its second,
  // so a flood of listings costs main at most one listing past the budget each second
  private listingRefused(pending: Pending): RefusalCode | null {
    if (this.policyJob('gate') === 'off') return null
    if (!this.askable()) return this.down('policy-down')
    return this.secondOf(pending.way.principal).spent >= this.limits.of(pending.way.plugin, 'filterMsPerSecond') ? 'throttled' : null
  }

  // The gate's time spent on behalf of one principal in the current second of the carrier's clock
  private secondOf(principal: string): { second: number, spent: number } {
    const now = this.clock()
    let spent = this.filtered.get(principal)
    if (spent === undefined || now - spent.second >= 1000 || now < spent.second) {
      spent = { second: now, spent: 0 }
      this.filtered.set(principal, spent)
    }
    return spent
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
    pending.release?.()
    pending.way.made.delete(pending.id)
    pending.parent?.children.delete(pending)
    pending.callee?.delivered.delete(pending.callId)
    if (pending.way.open) {
      const head = { v: VERSION, kind: 'reply', id: pending.id, callId: pending.callId }
      pending.answer(outcome.ok
        ? { ...head, ok: true, result: outcome.result }
        : { ...head, ok: false, refusal: this.refusalOf(pending.action, outcome) })
    }
    // 11 record
    const code = outcome.ok ? null : outcome.code
    const scope = !outcome.ok && pending.refusedScope !== undefined ? pending.refusedScope : pending.scope
    this.recordCall({
      at: pending.started, caller: pending.caller,
      ...(pending.onBehalf !== undefined ? { onBehalf: pending.onBehalf } : {}),
      root: pending.root.caller, action: pending.action,
      ...(scope !== undefined ? { scope } : {}),
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
      gate: this.policyJob('gate'),
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

  // 11 record: one audit record per call into recording's queue, never blocking the reply. A throw loses that record
  private recordCall(record: CallRecord, coalesce: boolean): void {
    this.recorded(recording => recording.call(record, coalesce))
  }

  // Recording took a record or let it go. A throw is that record lost and hetu runs on
  private recorded(take: (recording: Recording) => void): void {
    if (this.recording === null) return
    try {
      take(this.recording)
    } catch {}
  }

  private coalesced(event: string, fields: Record<string, Field>, keyed?: Parameters<Recording['coalesced']>[2], weight?: number): void {
    this.recorded(recording => recording.coalesced(event, fields, keyed, weight))
  }

  // The core's log failing, as recording reads it, for the gate off to refuse calls with power until fail-stop. One it
  // can't say counts as failing
  private logFailing(): boolean {
    try {
      return this.recording?.failing() === true
    } catch {
      return true
    }
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
    this.coalesced('fault', { plugin, step })
  }

  // plugin is whose code threw, so the text can go to that plugin's own debug and not the caller's
  private debugOf(asker: Asker, plugin: string | null, err: unknown): void {
    try {
      const text = err instanceof Error ? err.message : String(err)
      this.options.debug?.({ plugin, caller: asker.caller, action: asker.action, text })
    } catch {}
  }

  // The seams are later parts of the core and a throw there must not open anything: a policy job that can't be read is
  // failed, a plugin that can't be read is absent
  private policyJob(id: string): PolicyJobState {
    try {
      const state = this.options.pluginsManager.policyJob(id)
      return isOne(policyJobStates, state) ? state : 'failed'
    } catch {
      return 'failed'
    }
  }

  private info(id: string): PluginInfo | null {
    try {
      const info = this.options.pluginsManager.plugin(id)
      return info !== null && typeof info === 'object' && isOne(pluginStates, info.state) ? info : null
    } catch {
      return null
    }
  }

  private view(): number | null {
    try {
      const view = this.options.pluginsManager.view()
      return Number.isSafeInteger(view) ? view : null
    } catch {
      return null
    }
  }

  // Revoked unless the plugins manager says plainly it is not, so a view that throws refuses
  private revoked(label: string): boolean {
    try {
      return this.options.pluginsManager.revoked(label) !== false
    } catch {
      return true
    }
  }

  private armed(caller: Caller): boolean {
    try {
      return this.options.armed?.(caller) === true
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
