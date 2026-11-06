import type { Caller } from '../../api/envelope.ts'
import type { FloorConstant } from '../../api/floor.ts'
import type { GuardableAction } from '../../api/ids.ts'
import type { Access, Call, Gate, Guard, PluginState, Provider, SlotState, Watchdog } from '../../api/slots.ts'
import type { Field } from '../../lib/event-log.ts'

// What the later parts give the carrier, each a small interface the tests fake. The carrier imports nothing from boot

// One end of a channel as the carrier holds it. Node's MessagePort fits as it is. Electron's MessagePortMain wraps the
// data in its message event, so the runtime adapts it at step 10
export type Port = {
  postMessage(message: unknown): void
  start(): void
  close(): void
  on(event: 'message' | 'messageerror' | 'close', listener: (value: unknown) => void): unknown
}

// A plugin as a call target or a provider. actions are the manifest's provides.actions and serves is the half that
// answers them
export type PluginInfo = {
  state: PluginState
  place: 'host' | 'sandboxed' | 'page'
  incarnation: number
  serves: string
  actions: Readonly<Record<string, { readonly from?: readonly string[] }>>
}

type Values = Readonly<Partial<Record<FloorConstant, number>>>

// The human's limits from the state, a value per constant for all plugins and per plugin. A value replaces the floor
// constant whether it raises or lowers it. One for the plugin wins over one for all
export type HumanLimits = { all: Values, plugins: Readonly<Record<string, Values>> }

// What the loader owns, from step 6: lifecycle, the state and the StateView it pushes to the gate
export type Loader = {
  // The state of the install plugin holding a slot or a guard role
  slot(id: string): SlotState
  // The number of the newest StateView pushed to the gate
  view(): number
  // null for no such plugin
  plugin(id: string): PluginInfo | null
  limits(): HumanLimits
  recordNothing(): boolean
  // A way in closed under its plugin or was closed for a flood. The loader moves dependents to waiting before this
  // returns and the carrier then answers the calls the plugin held
  crashed(caller: Caller, reason: 'closed' | 'flood'): void
  // Lifecycle messages a plugin sends, which the carrier only passes on
  heard(caller: Caller, kind: 'ready' | 'pong' | 'stopped'): void
}

// Raises the prompt behind a gate's ask and names the held request. Comes with the trusted window at step 14
export type Asks = { raise(ask: string, access: Access): string }

// Where an error's text goes, never to a reply or a record. plugin is whose code threw: a provider, the gate or a
// guard, or null for the core's own code. The text belongs in that plugin's debug, never the caller's, since a
// provider's or the gate's text can name paths
export type Debug = (entry: { plugin: string | null, caller: Caller, action: string, text: string }) => void

// A namespace a later part serves with its own checks: events.* the bus from step 5 and ui.* the runtime and the mount
export type Served = (call: Call) => Promise<unknown>

// The one EventLog boot opened, or something with its append. healthy still true after a failed append means the log
// refused that record, not that the log is down
export type FloorLog = { append(event: string, fields?: Record<string, Field>): Promise<void>, readonly healthy?: boolean }

export type CarrierOptions = {
  loader: Loader
  // The holder's interface while the slot or role is on, else null
  gate: () => Gate | null
  guards: (id: string) => Guard | null
  providers: (id: string) => Provider | null
  watchdog: () => Watchdog | null
  log: FloorLog | null
  asks?: Asks
  // Core actions the loader and the runtime serve: security.* from step 14, watchdog.stop and watchdog.restart from 6
  core?: Served
  served?: { events?: Served, ui?: Served }
  debug?: Debug
  // ms since the epoch, for deadlines and the times records carry
  now?: () => number
  // A clock no change of the wall clock moves, for rates, the flood cap and timing a guard's answer
  clock?: () => number
  // The guards expected on an action, in the order they answer. Defaults to core/api's list, tests name others since
  // core/api expects none until #77
  guardsFor?: (action: GuardableAction) => readonly string[]
  // How long the floor lane waits before it tries a failed append again
  floorRetryMs?: number
}
