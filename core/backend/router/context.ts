import { randomBytes } from 'node:crypto'
import type { CoreAction, EventAction, ProviderAction, RoleAction } from '../../api/actions.ts'
import type { CapabilityType } from '../../api/capabilities.ts'
import { grantKeyOf, reasonCodes, refusalCodes, type Caller, type ReasonCode, type RefusalCode } from '../../api/envelope.ts'
import { frozen } from '../../api/plain.ts'
import { guards as expectedGuards, type GuardableAction, type Part } from '../../api/ids.ts'
import { pluginStates, policyJobStates, type LiveCall, type Pair, type PluginInfo, type PluginTable, type Scope, type PolicyJobState } from '../../api/policy-jobs.ts'
import type { Field } from '../../lib/event-log.ts'
import { Bus } from './bus.ts'
import { Limits } from './limits.ts'
import type { Asks, RouterOptions, Heard, Served, WayClosed } from './header.ts'
import type { Counted } from '../flood-control/header.ts'
import type { CallRecord, Join, Recording } from '../recording/header.ts'

// What the steps of a call share: the shapes of a way in and an open call, the small readers every step uses and the
// Context holding the options, the ways in and the seams to the later parts

export type Send = (message: unknown) => void

// A way in: one port, one host handle or one window, with its caller bound when it was made. principal is whose
// ceiling and limits apply, the plugin across its halves and incarnations or the window
export type Way = {
  caller: Caller
  key: string
  principal: string
  plugin: string | null
  // utility is the port of a utility process the core started, recorded as the plugins manager registered it
  via: 'port' | 'utility' | 'handle' | 'window'
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

export type Root = { principal: string, plugin: string | null, caller: Caller }

// An open call. Every field is readonly, so a field written after creation is written only through its owner's setter,
// by the README's table. A write outside the owner that has to stay casts to Writable with its why on the line
export type Pending = {
  readonly callId: string
  readonly id: number
  readonly way: Way
  readonly answer: Send
  readonly caller: Caller
  // The parent's for a sub-call, the caller's own text otherwise
  readonly onBehalf: string | undefined
  // The pair the call is judged for beside its caller: the chain's under a plugin root, none for the root call itself
  readonly pair: Pair | undefined
  readonly action: string
  readonly parent: Pending | null
  readonly root: Root
  readonly depth: number
  readonly deadline: number
  // The deadline on the clock no change of the wall clock moves. The steps check it before they hand a call on, since
  // a gate or a guard can run past it before the timer gets a turn
  readonly due: number
  // Gives the call's room back to the flood control that took it, null when none did
  readonly release: (() => void) | null
  readonly children: Set<Pending>
  readonly callee: Way | null
  readonly timer: ReturnType<typeof setTimeout> | null
  readonly done: boolean
  readonly started: number
  readonly gate: PolicyJobState
  readonly scope: Scope | undefined
  // The paths of a second ask the gate or a guard refused after the last one let on, which a call that ends refused
  // records in place of scope
  readonly refusedScope: Scope | undefined
  readonly coalesce: boolean
  // The view of this call a part gets with an action that names it, made once, so a part can keep what it needs with it
  readonly live: LiveCall | null
  // Aborts the signal the call carries into perform
  readonly ended: AbortController
  // What the gate let on at the canonical stage, which a new grants snapshot judges again, null until then and for a
  // call with no power
  readonly judged: { kind: Extract<Kind, { kind: 'power' }>, scope: Scope } | null
  // The code a call its grant no longer covers answers once its perform throws
  readonly revoked: RefusalCode | null
  // A provider's perform was called, so a revoke lets it end on its own rather than answering at once
  readonly performing: boolean
}

// T with only readonly dropped, for an owner's setter and a clash, which the cast check counts
export type Writable<T> = { -readonly [K in keyof T]: T[K] }

// Where a call goes, by the route the namespace table gives its namespace: the part serving it with the contract's entry
// for the action, or a plugin. each: every call is an audit record of its own
export type Target =
  | { kind: 'action', part: Part, spec: CoreAction, each: boolean }
  | { kind: 'bus', spec: EventAction }
  | { kind: 'served', part: Part }
  | { kind: 'provider', provider: Part, spec: ProviderAction }
  | { kind: 'role', spec: RoleAction }
  | { kind: 'plugin', target: string, name: string }

// also is a provider action's second requirement: its capability over the paths at these places in the scope
export type Kind =
  | { kind: 'action' | 'served' | 'free' | 'role' }
  | { kind: 'power', capability: CapabilityType, scope: Scope, also?: { capability: CapabilityType, at: readonly number[] } }

export type No = { code: RefusalCode, reason?: ReasonCode, request?: string }
export type Outcome = { ok: true, result: unknown } | ({ ok: false } & No)

// What the audit record of a call names, read from the envelope once it parsed. parent is the live call it named, whose
// onBehalf a call under it records whatever its own envelope said
export type About = { id: number | null, action: string, onBehalf: string | undefined, parent: Pending | null }

// Who the gate is asked for: a call, or a subscription the bus asks about again
export type Asker = { caller: Caller, root: { readonly caller: Caller }, onBehalf: string | undefined, pair?: Pair | undefined, action: string }

export type Shaped =
  | ({ ok: false, no: No } & About)
  | ({ ok: true, id: number, target: Target, args: unknown, bytes: number } & About)

export const no = (code: RefusalCode, reason?: ReasonCode): Outcome => ({ ok: false, code, ...(reason ? { reason } : {}) })

// The pair a chain carries: the root plugin's id and the grant key of the onBehalf it set. A window's onBehalf names
// who a change was made for and makes no pair, nor does a chain whose root set none
export function pairOf(root: Caller, field: string | undefined): Pair | undefined {
  return field !== undefined && root.kind === 'plugin' ? frozen({ plugin: root.id, field: grantKeyOf(field) }) : undefined
}

// Random, in core/api's token grammar
export const newId = () => randomBytes(16).toString('base64url')

export const isOne = <T extends string>(list: readonly T[], value: unknown): value is T => (list as readonly unknown[]).includes(value)

export function keyOf(caller: Caller): string {
  if (caller.kind === 'plugin') return `plugin:${caller.id}:${caller.half}:${caller.incarnation}`
  if (caller.kind === 'window') return `window:${caller.role}:${caller.n}`
  return `content:${caller.plugin}:${caller.token}`
}

export function field(message: unknown, name: string): unknown {
  return typeof message === 'object' && message !== null ? (message as Record<string, unknown>)[name] : undefined
}

// The plugin id or core namespace an action or a topic starts with
export const namespaceOf = (name: string) => name.slice(0, name.indexOf('.'))

// A subscriber as a core record names it
export function whoOf(caller: Caller): Record<string, Field> {
  if (caller.kind === 'plugin') return { plugin: caller.id, half: caller.half }
  if (caller.kind === 'window') return { window: caller.role }
  return { plugin: caller.plugin }
}

// A record's value holds at most MAX_TOPICS_TEXT characters, so a record names the topics that fit, space separated,
// with how many there were in all
const MAX_TOPICS_TEXT = 4096
export function topicsOf(topics: readonly string[]): Record<string, Field> {
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
export const joinTopics: Join = (held, next) => {
  const named = (fields: Record<string, Field> | null) => (fields === null || fields.topics === '' ? [] : String(fields.topics).split(' '))
  return { ...next, ...topicsOf([...new Set([...named(held), ...named(next)])]) }
}

// A refusal a provider or a seam gave or threw: its code and a fixed reason, nothing else
export function refusalIn(value: unknown): No | null {
  const code = field(value, 'code')
  if (!isOne(refusalCodes, code)) return null
  const reason = field(value, 'reason')
  return isOne(reasonCodes, reason) ? { code, reason } : { code }
}

// What every step of a call shares: the options, the ways in and the seams to the later parts, each read so that a
// throw there opens nothing
export class Context {
  readonly options: RouterOptions
  readonly now: () => number
  readonly clock: () => number
  readonly limits: Limits
  // Recording, none with no log
  readonly recording: Recording | null
  readonly ways = new Map<string, Way>()
  readonly ports = new WeakSet<object>()
  readonly guardsFor: (action: GuardableAction) => readonly string[]
  readonly bus: Bus
  // The grants snapshot number core.security last went out for, undefined until the first one the router reads
  announced: number | undefined = undefined
  closed = false
  // Shutdown began: the plugins manager reports what it stops as failed, so a policy job, guard or provider that is down answers stopped
  shutting = false
  // What the plugins manager handed in through the door: its table, the namespaces it serves with the runtime's, the
  // prompt behind an ask and the listeners for what the ways in heard. Every read before the table arrives is absent
  table: PluginTable | null = null
  readonly served = new Map<Part, Served>()
  asks: Asks | null = null
  readonly wayClosed: WayClosed[] = []
  readonly heard: Heard[] = []

  constructor(options: RouterOptions, bus: (c: Context) => Bus) {
    this.options = options
    this.now = options.now ?? Date.now
    this.clock = options.clock ?? (() => performance.now())
    this.limits = new Limits(() => this.tableOf().limits())
    this.recording = options.recording
    this.guardsFor = options.guardsFor ?? (action => expectedGuards[action])
    this.bus = bus(this)
  }

  // The answer for something that is down: what it is outside shutdown, stopped once shutdown began
  down(code: 'policy-down' | 'guard-down' | 'unavailable'): RefusalCode {
    return this.shutting ? 'stopped' : code
  }

  // 11 record: one audit record per call into recording's queue, never blocking the reply. A throw loses that record
  recordCall(record: CallRecord, coalesce: boolean): void {
    this.recorded(recording => recording.call(record, coalesce))
  }

  // Recording took a record or let it go. A throw is that record lost and hetu runs on
  recorded(take: (recording: Recording) => void): void {
    if (this.recording === null) return
    try {
      take(this.recording)
    } catch {
      // What recording can't take is lost (a call's record, a fault or its close) and hetu runs on, a record never
      // holds up or fails a call
    }
  }

  coalesced(event: string, fields: Record<string, Field>, keyed?: Parameters<Recording['coalesced']>[2], weight?: number): void {
    this.recorded(recording => recording.coalesced(event, fields, keyed, weight))
  }

  fault(plugin: string, step: string): void {
    this.coalesced('fault', { plugin, step })
  }

  // plugin is whose code threw, so the text can go to that plugin's own debug and not the caller's
  debugOf(asker: Asker, plugin: string | null, err: unknown): void {
    try {
      const text = err instanceof Error ? err.message : String(err)
      this.options.debug?.({ plugin, caller: asker.caller, action: asker.action, text })
    } catch {
      // Only the debug text is lost, the caller's answer is failed either way
    }
  }

  // The seams are later parts of the core and a throw there must not open anything: a policy job that can't be read is
  // failed, a plugin that can't be read is absent
  private tableOf(): PluginTable {
    if (this.table === null) throw new Error('no plugin table yet')
    return this.table
  }

  // Tells each listener in turn. A listener that throws stops none of the others
  tell<A extends unknown[]>(listeners: readonly ((...args: A) => void)[], ...args: A): void {
    for (const listener of listeners) {
      try {
        listener(...args)
      } catch {
        // A listener that throws can't keep the ones after it from hearing
      }
    }
  }

  policyJob(id: string): PolicyJobState {
    try {
      const state = this.tableOf().policyJob(id)
      return isOne(policyJobStates, state) ? state : 'failed'
    } catch {
      return 'failed'
    }
  }

  info(id: string): PluginInfo | null {
    try {
      const info = this.tableOf().plugin(id)
      return info !== null && typeof info === 'object' && isOne(pluginStates, info.state) ? info : null
    } catch {
      return null
    }
  }

  // The plugin holding a role's item, null for none and for a table that throws
  holderOf(action: string): string | null {
    try {
      const id = this.tableOf().holderOf(action)
      return typeof id === 'string' ? id : null
    } catch {
      return null
    }
  }

  view(): number | null {
    try {
      const view = this.tableOf().view()
      return Number.isSafeInteger(view) ? view : null
    } catch {
      return null
    }
  }

  // The gate module's count of the gate's time: throttled once the caller spent its second, null with time left or no
  // count handed in. A count that throws or answers other than yes or no crashed in use, so it is recorded and refuses
  // as the gate down (D-645)
  gateSpent(principal: string, plugin: string | null): RefusalCode | null {
    const time = this.options.gateTime
    if (time === undefined) return null
    try {
      const spent: unknown = time.spent(principal, plugin)
      if (typeof spent !== 'boolean') throw new Error('a count that answers neither yes nor no')
      return spent ? 'throttled' : null
    } catch {
      this.fault('gate', 'spent')
      return this.down('policy-down')
    }
  }

  gateCharge(principal: string, ms: number): void {
    try {
      this.options.gateTime?.charge(principal, ms)
    } catch {
      // This call's gate time goes uncounted and the call still answers, since whether it should refuse isn't decided.
      // A charge that always throws turns the throttle off for good, so each throw is recorded
      this.fault('gate', 'charge')
    }
  }

  armed(caller: Caller): boolean {
    try {
      return this.options.armed?.(caller) === true
    } catch {
      return false
    }
  }

  holder<T>(get: () => T | null): T | null {
    try {
      return get() ?? null
    } catch {
      return null
    }
  }
}
