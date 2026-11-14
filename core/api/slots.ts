import type { Capability, CapabilityType } from './capabilities.ts'
import type { Caller, Refusal, RefusalCode } from './envelope.ts'
import { frozen } from './plain.ts'

// What a call reaches as the gate and the guards judge it. paths are luoshu paths, the caller's own text at precheck and
// canonical once the provider has prepared the call. target is the plugin a plugin call reaches. topics are the topics
// a subscribe names that the gate holds, each already canonical as written. access is what a history action does with
// its paths, from core/api's action table and never from the caller or the provider. command is an exec call's whole
// argument array, which is canonical as written
export type Scope = {
  readonly paths?: readonly string[]
  readonly target?: string
  readonly topics?: readonly string[]
  readonly access?: 'read' | 'commit'
  readonly command?: readonly string[]
}

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
  // For a listing only: whether the caller may see a name, as the gate answers. The provider pages over the names it
  // allows, so no name the caller can't list reaches it, not even as where the next page starts
  readonly canList?: (path: string) => boolean
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
// volume ignores case. execAny names the plugins the human let exec run any command for, past their declared lists
export type StateView = {
  readonly n: number
  readonly foldCase: boolean
  readonly plugins: Readonly<Record<string, readonly GrantedItem[]>>
  readonly execAny: readonly string[]
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

// The class names, from 0 to 4. A class is read from what a plugin asks for and what it reaches, never from its author
export const classNames = frozen(['Contained', 'Reader', 'Writer', 'Network', 'Powerful'] as const)

// A plugin with what it holds
export type Peer = { readonly id: string, readonly granted: readonly Capability[] }

// Where data can move to and from a plugin, followed in turn: along plugin.call both ways, since a callee answers its
// caller, and along a subscription from the plugin that owns the topic to the plugin that hears it, never back. Hearing
// a plugin gives the listener none of its grants, so this feeds the pair rule alone. heard is each of the plugin's
// subscriptions to another plugin's topics with what every plugin upstream through it holds. With no flow given the
// links are plugin.call's alone, so upstream and downstream are both what plugin.call reaches
export type Flow = {
  readonly upstream: readonly Peer[]
  readonly downstream: readonly Peer[]
  readonly heard: readonly { readonly item: Capability, readonly upstream: readonly Capability[] }[]
}

// What the trusted window shows under the core's words is made from: what the plugin asks for, what it reaches through
// plugin.call followed in turn, every plugin connected to it that way with what each holds and where data moves to and
// from it. Which of those read is policy
export type ScreenSubject = {
  readonly granted: readonly Capability[]
  readonly reachable: readonly Capability[]
  readonly callers: readonly Peer[]
  readonly flow?: Flow
}

// A plugin whose class a change moves, the changed plugin or another whose links it moves: the class its entry holds
// and the one the change gives it, null for a class not known
export type ClassMove = { readonly id: string, readonly from: number | null, readonly to: number | null }

// The capabilities slot. A plugin's class from 0 to 4, the items that ask at first use and the screen. The loader asks
// it at every class change, the changed plugin's and every other plugin's whose links the change moves. A throw counts
// as the slot down, which leaves a class null, counted as 4. moves gives the lines a request's Confirm shows for the
// classes the change moves, which a slot without it shows none of
export type Capabilities = {
  classify(granted: readonly Capability[], reachable: readonly Capability[], flow?: Flow): number
  firstUse(granted: readonly Capability[], reachable: readonly Capability[], flow?: Flow): Capability[]
  screen(subject: ScreenSubject): string[]
  moves?(moves: readonly ClassMove[]): string[]
}

// How the loader clears a space through the storage plugin, so the clear runs after every call already queued on the
// space and nothing a stopped plugin queued lands after it
export type StorageRole = { clear(kind: 'storage' | 'cache', space: string): Promise<void> }

// The notes folder the human picked, null for none, and hetu's own folders, which a luoshu picked around them holds
export type Opening = { readonly folder: string | null, readonly dataDir: string, readonly installDir: string }

// What the luoshu alone is handed beside its folder: the OS's bin the runtime gives, which rejects when the bin refuses
// a file. None in a core with no bin, where a remove answers unavailable
export type LuoshuOpening = Opening & { readonly trash?: (absolute: string) => Promise<void> }

// How the loader hands the luoshu its folder: when the plugin is ready and each time luoshu.set applies. A throw marks
// the luoshu failed
export type LuoshuRole = { open(opening: LuoshuOpening): void }

// How the loader hands history the notes folder: when the plugin is ready and each time luoshu.set applies. A throw
// marks history failed
export type HistoryRole = { open(opening: Opening): void }

// One exec item a plugin holds: its exact commands and the variables they get by name
export type ExecGrant = { readonly commands: readonly (readonly string[])[], readonly env: readonly string[] }

// What exec checks a command against on its own, gate off included: each plugin's exec items, the plugins the human let
// run any command and the folders no command may run code from. Read-only, renewed with every StateView
export type ExecView = {
  readonly plugins: Readonly<Record<string, readonly ExecGrant[]>>
  readonly any: readonly string[]
  readonly opening: Opening
}

// How the loader hands exec its view. A throw marks exec failed
export type ExecRole = { stateChanged(view: ExecView): void }

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

