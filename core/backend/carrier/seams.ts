import type { Caller } from '../../api/envelope.ts'
import type { LimitName } from '../../api/limits.ts'
import type { GuardableAction } from '../../api/ids.ts'
import type { Access, Call, Gate, Guard, PluginState, Provider, PolicyJobState, Watchdog } from '../../api/policy-jobs.ts'
import type { Field } from '../../lib/event-log.ts'
import type { AuditLog } from './audit.ts'

// What the later parts give the carrier, each a small interface the tests fake. The carrier imports nothing from boot

// One end of a channel as the carrier holds it. Node's MessagePort fits as it is. Electron's MessagePortMain wraps the
// data in its message event, so the Electron runtime adapts it
export type Port = {
  postMessage(message: unknown): void
  start(): void
  close(): void
  on(event: 'message' | 'messageerror' | 'close', listener: (value: unknown) => void): unknown
}

// A plugin as a call target. actions are the manifest's provides.actions and serves is the half that answers them.
// topics are the manifest's provides.topics, each published as <id>.<name>, which the bus reads
export type PluginInfo = {
  state: PluginState
  place: 'host' | 'utility' | 'sandboxed' | 'page'
  incarnation: number
  serves: string
  actions: Readonly<Record<string, { readonly from?: readonly string[] }>>
  topics: readonly string[]
}

type Values = Readonly<Partial<Record<LimitName, number>>>

// The human's limits from the state, a value per constant for all plugins and per plugin. A value replaces the fixed
// value whether it raises or lowers it. One for the plugin wins over one for all
export type HumanLimits = { all: Values, plugins: Readonly<Record<string, Values>> }

// What the plugins manager owns: lifecycle, the state and the grants snapshot it pushes to the gate
export type PluginsManager = {
  // The state of a policy job or a guard role, as the core module or core plugin holding it reads
  policyJob(id: string): PolicyJobState
  // The number of the newest grants snapshot pushed to the gate
  view(): number
  // null for no such plugin
  plugin(id: string): PluginInfo | null
  limits(): HumanLimits
  recordNothing(): boolean
  // Whether the human revoked an agent's label and mcp-http-handler has not yet said it ended its tokens, from the plugins manager's state
  revoked(label: string): boolean
  // A way in closed under its plugin or was closed for a flood. The plugins manager moves dependents to waiting before this
  // returns and the carrier then answers the calls the plugin held
  crashed(caller: Caller, reason: 'closed' | 'flood' | 'malformed'): void
  // Lifecycle messages a plugin sends, which the carrier only passes on, and alive for anything at all main heard from a
  // utility half, before its rate
  heard(caller: Caller, kind: 'ready' | 'pong' | 'stopped' | 'alive'): void
}

// Raises the prompt behind a gate's ask and names the held request, or refuses: throttled while another ask from the
// same plugin is open, not-granted for an item that doesn't ask and with declined for one the human cancelled this run
export type AskRefusal = { code: 'throttled' } | { code: 'not-granted', reason?: 'declined' }
export type Asks = { raise(ask: string, access: Access): string | AskRefusal }

// Where an error's text goes, never to a reply or a record. plugin is whose code threw: a provider, the gate or a
// guard, or null for the core's own code. The text belongs in that plugin's debug, never the caller's, since a
// provider's or the gate's text can name paths
export type Debug = (entry: { plugin: string | null, caller: Caller, action: string, text: string }) => void

// A namespace a later part serves with its own checks: ui.* the runtime and the drawer. The bus serves events.* inside
// the carrier
export type Served = (call: Call) => Promise<unknown>

// What the core record lane writes through: the one EventLog boot opened, or something with its append. healthy still true
// after a failed append means the log refused that record, not that the log is down
export type CoreRecordLog = { append(event: string, fields?: Record<string, Field>): Promise<void>, readonly healthy?: boolean }

// The one EventLog boot opened as the carrier holds it: the core record lane appends one record at a time, the audit writer
// appends batches and log.segments and log.verify read it
export type CoreLog = CoreRecordLog & AuditLog

// What became of one core record: on disk, not taken while the human turned recording off, or lost: dropped from a
// full backlog, refused by the log or still waiting when the lane closed
export type Landing = 'landed' | 'muted' | 'lost'

export type CarrierOptions = {
  pluginsManager: PluginsManager
  // The holder's interface while the policy job or role is on, else null. A provider by its namespace's holder
  gate: () => Gate | null
  guards: (id: string) => Guard | null
  providers: (id: string) => Provider | null
  watchdog: () => Watchdog | null
  log: CoreLog | null
  asks?: Asks
  // Whether the trusted window took input long enough to count a Confirm: past the input delay since it last showed or
  // gained focus. The runtime keeps the times. With nothing to ask, no Confirm counts
  armed?: (caller: Caller) => boolean
  // The core's log has failed: its oldest record waited logFailMs unwritten while recording was on. Told until the
  // plugins manager takes it, which quits hetu to start it again. false says it wasn't taken, while hetu starts or stops
  logFailed?: () => boolean | void
  // Core actions the plugins manager and the runtime serve: watchdog.stop and watchdog.restart from the plugins manager, security.* once
  // the trusted window exists
  core?: Served
  served?: { ui?: Served }
  debug?: Debug
  // ms since the epoch, for deadlines and the times records carry
  now?: () => number
  // A clock no change of the wall clock moves, for rates, the flood cap and timing a guard's answer
  clock?: () => number
  // The guards expected on an action, in the order they answer. Defaults to core/api's list, tests name others since
  // core/api expects none until #77
  guardsFor?: (action: GuardableAction) => readonly string[]
  // How long the core record lane waits before it tries a failed append again
  coreRecordRetryMs?: number
  // How often the audit writer writes the queue, 100 ms unless a test names another
  auditEveryMs?: number
  // watchdog.limit lowered one of this plugin's constants, which the runtime passes on to the relay in the worker host page
  limited?: (plugin: string) => void
}
