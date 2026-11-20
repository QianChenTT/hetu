import type { Caller } from '../../api/envelope.ts'
import type { LimitName } from '../../api/limits.ts'
import type { GuardableAction, Part } from '../../api/ids.ts'
import type { Access, Call, Gate, GateTime, Guard, PluginTable, Provider } from '../../api/policy-jobs.ts'
import type { FloodControl } from '../flood-control/header.ts'
import type { Recording } from '../recording/header.ts'

// What the later parts give the carrier and what it offers them, each a small interface the tests fake. The carrier
// imports nothing from boot or the plugins manager

// One end of a channel as the carrier holds it. Node's MessagePort fits as it is. Electron's MessagePortMain wraps the
// data in its message event, so the Electron runtime adapts it
export type Port = {
  postMessage(message: unknown): void
  start(): void
  close(): void
  on(event: 'message' | 'messageerror' | 'close', listener: (value: unknown) => void): unknown
}

// What a plugin half's way in told the router, which it only passes on: ready, pong or stopped as sent, alive for
// anything main heard from a utility half, before its rate
export type Heard = (caller: Caller, kind: 'ready' | 'pong' | 'stopped' | 'alive') => void

// A way in closed under its plugin or was closed for a flood. Each listener runs before the router answers the calls
// the plugin held, so the plugins manager moves dependents to waiting first
export type WayClosed = (caller: Caller, reason: 'closed' | 'flood' | 'malformed') => void

// Raises the prompt behind a gate's ask and names the held request, or refuses: throttled while another ask from the
// same plugin is open, not-granted for an item that doesn't ask and with declined for one the human cancelled this run
export type AskRefusal = { code: 'throttled' } | { code: 'not-granted', reason?: 'declined' }
export type Asks = { raise(ask: string, access: Access): string | AskRefusal }

// Where an error's text goes, never to a reply or a record. plugin is whose code threw: a provider, the gate or a
// guard, or null for the core's own code. The text belongs in that plugin's debug, never the caller's, since a
// provider's or the gate's text can name paths
export type Debug = (entry: { plugin: string | null, caller: Caller, action: string, text: string }) => void

// A part serving the namespaces the contract's namespace table gives it, handed in under the part's name. It answers
// with its result or throws a refusal
export type Served = (call: Call) => Promise<unknown>

// What the carrier offers the plugins manager, which calls it and is never called back but through what it handed in:
// its table, the namespaces it serves, the prompt behind an ask and the listeners for what the ways in heard
export type CarrierDoor = {
  // Binds a half's port to its caller. The plugins manager calls it in the same step that mints the port
  register(port: Port, caller: Caller): void
  // Ends a way: a planned stop or a revoked incarnation. Its calls answer code and nothing more arrives from it
  end(caller: Caller, code?: 'stopped' | 'crashed'): void
  // A lifecycle message down a half's own way: init, deps, stop or ping. Dropped when the way is gone
  send(caller: Caller, message: unknown): void
  // A policy job state, a plugin state or the grants snapshot changed, so the carrier asks the gate about live
  // subscriptions again
  changed(): void
  // Shutdown has begun. From this call on a policy job, guard or provider that is down answers stopped
  stopping(): void
  // A limit as the carrier enforces it for one plugin, so the start and stop deadlines follow the same values
  limit(plugin: string, name: LimitName): number
  // The plugin table the carrier reads plugin and policy job state from, on each call and with no copy
  read(table: PluginTable): void
  // A part serving the namespaces the namespace table gives it
  serve(part: Part, served: Served): void
  // The prompt behind the gate's ask
  asks(asks: Asks): void
  onWayClosed(listener: WayClosed): void
  onHeard(listener: Heard): void
}

export type CarrierOptions = {
  // The holder's interface while the policy job or role is on, else null. A provider by its namespace's holder
  gate: () => Gate | null
  guards: (id: string) => Guard | null
  providers: (id: string) => Provider | null
  // Flood control while the human has it on, else null, which counts nothing and says yes to everything
  floodControl: () => FloodControl | null
  // The gate module's count of the gate's time each caller spends in a second, which a listing spends too. None counts
  // nothing
  gateTime?: GateTime
  // Recording, which takes each call's record, the carrier's own core records and log.segments and log.verify. null
  // records nothing and serves no log
  recording: Recording | null
  // Whether the trusted window took input long enough to count a Confirm: past the input delay since it last showed or
  // gained focus. The runtime keeps the times. With nothing to ask, no Confirm counts
  armed?: (caller: Caller) => boolean
  debug?: Debug
  // ms since the epoch, for deadlines and the times records carry
  now?: () => number
  // A clock no change of the wall clock moves, for rates, the flood cap and timing a guard's answer
  clock?: () => number
  // The guards expected on an action, in the order they answer. Defaults to core/api's list, tests name others since
  // core/api expects none until #77
  guardsFor?: (action: GuardableAction) => readonly string[]
}
