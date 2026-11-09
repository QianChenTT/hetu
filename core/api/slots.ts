import type { Capability, CapabilityType } from './capabilities.ts'
import type { Caller, Refusal, RefusalCode } from './envelope.ts'
import { frozen } from './plain.ts'

// What a call reaches as the gate and the guards judge it. paths are luoshu paths, the caller's own text at precheck and
// canonical once the provider has prepared the call. target is the plugin a plugin call reaches. topics are the topics
// a subscribe names that the gate holds, each already canonical as written
export type Scope = { readonly paths?: readonly string[], readonly target?: string, readonly topics?: readonly string[] }

// A call as the carrier hands it to a provider, a callee or a core action. callId is the carrier's own and deadline is
// in ms since the epoch, never later than the parent's
export type Call = {
  readonly callId: string
  readonly caller: Caller
  readonly onBehalf?: string
  readonly parent?: string
  readonly action: string
  readonly args: unknown
  readonly deadline: number
}

// What a guard judges. Never the arguments, so a guard can't act on note text or leak it
export type GuardCall = {
  readonly callId: string
  readonly caller: Caller
  readonly onBehalf?: string
  readonly action: string
  readonly scope: Scope
  readonly baseVersion?: string
}

// What the gate decides on: the raw request at precheck and the prepared object at decide. onBehalf rides along and is
// never decided on, so it grants nothing
export type Access = {
  readonly stage: 'raw' | 'canonical'
  readonly caller: Caller
  readonly onBehalf?: string
  readonly action: string
  readonly capability: CapabilityType
  readonly scope: Scope
}

// view is the number of the StateView the answer was made on. ask names what a Confirm would grant, at the canonical
// stage only
export type Decision =
  | { allow: true, view: number }
  | { allow: false, code: 'not-granted' | 'switched-off', view: number }
  | { ask: string, view: number }

// One capability a plugin holds, as the gate judges it: off once the human switched it off, firstUse while its first
// use still asks for a Confirm
export type GrantedItem = { readonly capability: Capability, readonly off: boolean, readonly firstUse: boolean }

// What the loader pushes to the gate, numbered so the carrier can refuse an answer made on an older one. plugins holds
// each plugin's grants as items, a folder plugin's from its entry and an install plugin's from its manifest, and leaves
// out a plugin holding nothing. Windows' grants are core/api's own and never here. foldCase is whether the luoshu's
// volume ignores case
export type StateView = {
  readonly n: number
  readonly foldCase: boolean
  readonly plugins: Readonly<Record<string, readonly GrantedItem[]>>
}

export type Gate = {
  decide(access: Access): Decision
  canRead(caller: Caller, path: string): boolean
  // Whether the caller may see the path's name: an on item of luoshu.list or luoshu.read covering it
  canList(caller: Caller, path: string): boolean
  verbs(plugin: string, window: string): string[]
  // A throw marks the gate failed
  stateChanged(view: StateView): void
}

// A host guard answers from its own state and makes no calls
export type Guard = { check(call: GuardCall): 'allow' | 'deny' }

// What prepare hands on: the canonical scope the gate and the guards judge and perform acts on, plus the version a
// write expects
export type Prepared = { readonly scope: Scope, readonly baseVersion?: string }

// A provider refuses with a fixed code and a fixed reason, never with text
export type ProviderRefusal = Pick<Refusal, 'code' | 'reason'>

// A provider serves a namespace. prepare may hold its per-path lock until perform. perform and release get the frozen
// copy the gate and the guards judged, not the object prepare gave, so anything else a provider keeps across a call it
// keys by callId. perform refuses by throwing a ProviderRefusal and anything else it throws answers failed
export type Provider = {
  prepare(call: Call): Promise<Prepared | ProviderRefusal>
  perform(call: Call, prepared: Prepared): Promise<unknown>
  // A call refused after prepare never reaches perform, so the provider lets go of its lock here
  release?(call: Call, prepared: Prepared): void
}

// A slot or guard role as the carrier applies it: on, off by the human, starting, failed (crashed, timed out,
// unresponsive or held by its marker), absent from the install or tampered
export const slotStates = frozen(['on', 'off', 'starting', 'failed', 'absent', 'tampered'] as const)
export type SlotState = typeof slotStates[number]

// A plugin's lifecycle state, which the loader owns
export const pluginStates = frozen([
  'found', 'refused', 'waiting', 'off', 'starting', 'ready', 'unresponsive', 'stopping', 'stopped', 'crashed', 'failed',
] as const)
export type PluginState = typeof pluginStates[number]

// What the watchdog hears from the carrier: messages over a port's rate dropped since the last sample, at most once a
// second per port. The runtime's samples come with the Electron runtime
// What the watchdog hears about a plugin: messages dropped over its rate, by the carrier or the relay in the worker host
// page, errors its worker threw, at most once a second, and the relay cutting its worker off
export type Sample =
  | { readonly kind: 'dropped' | 'errors', readonly caller: Caller, readonly count: number }
  | { readonly kind: 'cutoff', readonly caller: Caller, readonly reason: 'malformed' | 'flood' }
export type Watchdog = { sample(sample: Sample): void }

// One call in the audit queue, or a run of like calls from one caller in one second once coalesced. code is null for a
// call that succeeded. at, ms and scope are the first call's. scope is the canonical one prepare gave or a plugin call's
// target, so a call refused before prepare has none. Never arguments or results
export type AuditRecord = {
  seq: number
  at: number
  caller: Caller
  onBehalf?: string
  root: Caller
  action: string
  scope?: Scope
  code: RefusalCode | null
  ms: number
  gate: SlotState
  count: number
}

// One log file as history reads it through. start says how its first line begins: zeros begin a chain, continues
// follows the last line of the file before, unlinked follows neither, null when there is no good first line to tell.
// breaks are the line numbers in the file, from 1, that don't check out
export type LogSegment = {
  segment: number
  lines: number
  first: number | null
  last: number | null
  start: 'zero' | 'continues' | 'unlinked' | null
  breaks: number[]
}
// Whether the open log file's chain checks out, and where it first doesn't
export type LogVerification = { ok: true } | { ok: false, seq: number }

