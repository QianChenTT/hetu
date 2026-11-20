import { createHash, randomBytes } from 'node:crypto'
import type { CoreAction, ProviderAction } from '../../api/actions.ts'
import type { CapabilityType } from '../../api/capabilities.ts'
import { reasonCodes, refusalCodes, type Caller, type ReasonCode, type RefusalCode } from '../../api/envelope.ts'
import { guards as expectedGuards, type GuardableAction } from '../../api/ids.ts'
import { pluginStates, policyJobStates, type Scope, type PolicyJobState } from '../../api/policy-jobs.ts'
import type { Field } from '../../lib/event-log.ts'
import { Bus } from './bus.ts'
import { Limits } from './limits.ts'
import type { CarrierOptions, PluginInfo } from './header.ts'
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

export type Root = { principal: string, plugin: string | null, caller: Caller }

export type Pending = {
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
export type Filtering = { hash: string, gate: object, view: number | null, asked: number, kept: number[] }

export const hashOf = (paths: readonly string[]) => createHash('sha256').update(JSON.stringify(paths)).digest('hex')

export type Target =
  | { kind: 'core', spec: CoreAction }
  | { kind: 'events', action: string }
  | { kind: 'served', namespace: 'ui' }
  | { kind: 'provider', provider: string, spec: ProviderAction }
  | { kind: 'plugin', target: string, name: string }

// also is a provider action's second requirement: its capability over the paths at these places in the scope
export type Kind =
  | { kind: 'core' | 'served' | 'free' }
  | { kind: 'power', capability: CapabilityType, scope: Scope, also?: { capability: CapabilityType, at: readonly number[] } }

export type No = { code: RefusalCode, reason?: ReasonCode, request?: string }
export type Outcome = { ok: true, result: unknown } | ({ ok: false } & No)

// What the audit record of a call names, read from the envelope once it parsed. parent is the live call it named, whose
// onBehalf a call under it records whatever its own envelope said
export type About = { id: number | null, action: string, onBehalf: string | undefined, parent: Pending | null }

// Who the gate is asked for: a call, or a subscription the bus asks about again
export type Asker = { caller: Caller, onBehalf: string | undefined, agent?: string | undefined, action: string }

export type Shaped =
  | ({ ok: false, no: No } & About)
  | ({ ok: true, id: number, target: Target, args: unknown, bytes: number, agent: string | undefined, lends: string | undefined } & About)

export const no = (code: RefusalCode, reason?: ReasonCode): Outcome => ({ ok: false, code, ...(reason ? { reason } : {}) })

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
  readonly options: CarrierOptions
  readonly now: () => number
  readonly clock: () => number
  readonly limits: Limits
  // Recording, none with no log
  readonly recording: Recording | null
  readonly ways = new Map<string, Way>()
  readonly ports = new WeakSet<object>()
  // The gate's time filterReadable took in the current second for each caller of a live call, by principal
  readonly filtered = new Map<string, { second: number, spent: number }>()
  readonly guardsFor: (action: GuardableAction) => readonly string[]
  readonly bus: Bus
  // The grants snapshot number core.security last went out for
  announced: number | null | undefined = undefined
  closed = false
  // Shutdown began: the plugins manager reports what it stops as failed, so a policy job, guard or provider that is down answers stopped
  shutting = false

  constructor(options: CarrierOptions, bus: (c: Context) => Bus) {
    this.options = options
    this.now = options.now ?? Date.now
    this.clock = options.clock ?? (() => performance.now())
    this.limits = new Limits(() => options.pluginsManager.limits())
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
    } catch {}
  }

  coalesced(event: string, fields: Record<string, Field>, keyed?: Parameters<Recording['coalesced']>[2], weight?: number): void {
    this.recorded(recording => recording.coalesced(event, fields, keyed, weight))
  }

  // The core's log failing, as recording reads it, for the gate off to refuse calls with power until fail-stop. One it
  // can't say counts as failing
  logFailing(): boolean {
    try {
      return this.recording?.failing() === true
    } catch {
      return true
    }
  }

  fault(plugin: string, step: string): void {
    this.coalesced('fault', { plugin, step })
  }

  // plugin is whose code threw, so the text can go to that plugin's own debug and not the caller's
  debugOf(asker: Asker, plugin: string | null, err: unknown): void {
    try {
      const text = err instanceof Error ? err.message : String(err)
      this.options.debug?.({ plugin, caller: asker.caller, action: asker.action, text })
    } catch {}
  }

  // The seams are later parts of the core and a throw there must not open anything: a policy job that can't be read is
  // failed, a plugin that can't be read is absent
  policyJob(id: string): PolicyJobState {
    try {
      const state = this.options.pluginsManager.policyJob(id)
      return isOne(policyJobStates, state) ? state : 'failed'
    } catch {
      return 'failed'
    }
  }

  info(id: string): PluginInfo | null {
    try {
      const info = this.options.pluginsManager.plugin(id)
      return info !== null && typeof info === 'object' && isOne(pluginStates, info.state) ? info : null
    } catch {
      return null
    }
  }

  view(): number | null {
    try {
      const view = this.options.pluginsManager.view()
      return Number.isSafeInteger(view) ? view : null
    } catch {
      return null
    }
  }

  // Revoked unless the plugins manager says plainly it is not, so a view that throws refuses
  revoked(label: string): boolean {
    try {
      return this.options.pluginsManager.revoked(label) !== false
    } catch {
      return true
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
