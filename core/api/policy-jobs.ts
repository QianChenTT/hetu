import type { Capability, CapabilityType } from './capabilities.ts'
import type { Caller, Refusal, RefusalCode } from './envelope.ts'
import type { LimitName } from './limits.ts'
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

// The pair a chain under a plugin root carries: the root plugin's id and the grant key of the onBehalf it set, the
// whole onBehalf staying on the call. A chain whose root is a window carries none, its onBehalf naming who the change
// was made for and judged by nobody
export type Pair = { readonly plugin: string, readonly field: string }

// Who made a call, as every part the router hands it to reads it. callId is the router's own. root is the caller at the
// root of the chain, the caller itself for a call with no parent
export type CallHead = {
  readonly callId: string
  readonly caller: Caller
  readonly root: Caller
  readonly onBehalf?: string
}

// A call as the router hands it to a provider, a callee or a core action. deadline is in ms since the epoch, never
// later than the parent's
export type Call = CallHead & {
  readonly parent?: string
  readonly action: string
  readonly args: unknown
  readonly deadline: number
  // For a listing only: whether the caller may see a name, as the gate answers. The provider pages over the names it
  // allows, so no name the caller can't list reaches it, not even as where the next page starts
  readonly canList?: (path: string) => boolean
  // For a call with power: the gate and the guards asked again, as for the call's first judgement, about the paths the
  // provider would act on now, one for each path prepare gave. A provider asks when a look at the disk after the first
  // judgement reads a path otherwise. null lets the call go on on those paths
  readonly judge?: (paths: readonly string[]) => ProviderRefusal | null
  // For an action that names a live call delivered to its caller: a view of that call, the same object for as long as
  // the call lives
  readonly live?: LiveCall
  // Aborts once the call ends, answered or stopped, or once a new grants snapshot no longer covers a call let on. A
  // provider that can stop what it does stops then and throws, a single write finishes
  readonly signal?: CallSignal
}

// What a call's signal offers, as an AbortSignal does. reason is the refusal code the call ends with
export type CallSignal = {
  readonly aborted: boolean
  readonly reason: unknown
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

// A live call as the router hands it on with an action that names it, never the call itself: its own caller, whose
// principal and plugin its gate time counts against, the root of its chain with the onBehalf that root set, the pair
// the chain carries and whether it is still open
export type LiveCall = {
  readonly caller: Caller
  readonly principal: string
  readonly plugin: string | null
  readonly root: Caller
  readonly onBehalf?: string
  readonly pair?: Pair
  open(): boolean
}

// The gate's time a caller may spend in a second, filterMsPerSecond of it, counted by the gate module for
// gate.filterReadable and for the listings the router filters through the gate alike. principal is the caller's plugin
// across its halves and incarnations or its window, plugin the one whose limit applies, null for a window
export type GateTime = {
  spent(principal: string, plugin: string | null): boolean
  charge(principal: string, ms: number): void
}

// What a guard judges. Never the arguments, so a guard can't act on note text or leak it
export type GuardCall = CallHead & {
  readonly action: string
  readonly scope: Scope
  readonly baseVersion?: string
}

// What the gate decides on: the raw request at precheck and the prepared object at decide. root is the caller at the
// root of the chain. onBehalf rides along and is never decided on, so it grants nothing. pair is set by the router
// alone, for a call under the root call of a chain that carries one, whose items the call is judged against beside the
// caller's
export type Access = {
  readonly stage: 'raw' | 'canonical'
  readonly caller: Caller
  readonly root: Caller
  readonly onBehalf?: string
  readonly pair?: Pair
  readonly action: string
  readonly capability: CapabilityType
  readonly scope: Scope
}

// view is the number of the grants snapshot the answer was made on. ask names what a Confirm would grant, at the canonical
// stage only
export type Decision =
  | { allow: true, view: number }
  | { allow: false, code: 'not-granted' | 'switched-off', view: number }
  | { ask: string, view: number }

// One capability a plugin holds, as the gate judges it: off once the human switched it off, firstUse while its first
// use still asks for a Confirm
export type GrantedItem = { readonly capability: Capability, readonly off: boolean, readonly firstUse: boolean }

// What the plugins manager pushes to the gate, numbered so the router can refuse an answer made on an older one. plugins holds
// each plugin's grants as items, a folder plugin's from its entry and a core plugin's from its manifest, and leaves
// out a plugin holding nothing. Windows' grants are core/api's own and never here. foldCase is whether the luoshu's
// volume ignores case. execAny names the plugins the human let exec run any command for, past their declared lists.
// pairs holds each pair's own items by the root plugin's id and then the field, none of them the root plugin's own.
// revoked names the fields the human revoked under each root plugin's id for this run. A view with no pairs gives
// every pair nothing
export type GrantsSnapshot = {
  readonly n: number
  readonly foldCase: boolean
  readonly plugins: Readonly<Record<string, readonly GrantedItem[]>>
  readonly execAny: readonly string[]
  readonly pairs?: Readonly<Record<string, Readonly<Record<string, readonly GrantedItem[]>>>>
  readonly revoked?: Readonly<Record<string, readonly string[]>>
}

// With a pair, canRead and canList answer for the caller's own items and the pair's both
export type Gate = {
  decide(access: Access): Decision
  canRead(caller: Caller, path: string, pair?: Pair): boolean
  // Whether the caller may see the path's name: an on item of luoshu.list or luoshu.read covering it
  canList(caller: Caller, path: string, pair?: Pair): boolean
  verbs(plugin: string, window: string): string[]
  // A throw marks the gate failed
  stateChanged(view: GrantsSnapshot): void
}

// The class names, from 0 to 4. A class is read from what a plugin asks for and what it reaches, never from its author
export const classNames = frozen(['Contained', 'Reader', 'Writer', 'Network', 'Powerful'] as const)

// How the plugins manager clears a space through storage, so the clear runs after every call already queued on the
// space and nothing a stopped plugin queued lands after it
export type StorageRole = { clear(kind: 'storage' | 'cache', space: string): Promise<void> }

// The notes folder the human picked, null for none, and hetu's own folders, which a luoshu picked around them holds
export type Opening = { readonly folder: string | null, readonly dataDir: string, readonly installDir: string }

// What the luoshu alone is handed beside its folder: the OS's bin the runtime gives, which rejects when the bin refuses
// a file. None in a core with no bin, where a remove answers unavailable
export type LuoshuOpening = Opening & { readonly trash?: (absolute: string) => Promise<void> }

// How the core hands the luoshu its folder: at start, when the luoshu is switched on again and each time luoshu.pick
// applies. A throw marks the luoshu failed
export type LuoshuRole = { open(opening: LuoshuOpening): void }

// How the core hands history the notes folder: at start, when history is switched on again and each time luoshu.pick
// applies. A throw marks history failed
export type HistoryRole = { open(opening: Opening): void }

// One exec item a plugin holds: its exact commands and the variables they get by name
export type ExecGrant = { readonly commands: readonly (readonly string[])[], readonly env: readonly string[] }

// What exec checks a command against on its own, gate off included: each plugin's exec items, the plugins the human let
// run any command and the folders no command may run code from. Read-only, renewed with every grants snapshot
export type ExecView = {
  readonly plugins: Readonly<Record<string, readonly ExecGrant[]>>
  readonly any: readonly string[]
  readonly opening: Opening
}

// How the core hands exec its view, with every grants snapshot. A throw marks exec failed
export type ExecRole = { stateChanged(view: ExecView): void }

// A host guard answers from its own state and makes no calls
export type Guard = { check(call: GuardCall): 'allow' | 'deny' }

// What prepare hands on: the canonical scope the gate and the guards judge and perform acts on, plus the version a
// write expects
export type Prepared = { readonly scope: Scope, readonly baseVersion?: string }

// A provider refuses with a fixed code and a fixed reason, never with text
export type ProviderRefusal = Pick<Refusal, 'code' | 'reason'>

// A provider serves a namespace. prepare may hold its latch on a path until perform. perform and release get the frozen
// copy the gate and the guards judged, not the object prepare gave, so anything else a provider keeps across a call it
// keys by callId. perform refuses by throwing a ProviderRefusal and anything else it throws answers failed
export type Provider = {
  prepare(call: Call): Promise<Prepared | ProviderRefusal>
  perform(call: Call, prepared: Prepared): Promise<unknown>
  // A call refused after prepare never reaches perform, so the provider lets go of its latch here
  release?(call: Call, prepared: Prepared): void
}

// A policy job or guard role as the router applies it: on, off by the human, starting until its module is started,
// failed (its module's last push threw, or the stopped mode closed it) or absent, held by nothing that runs
export const policyJobStates = frozen(['on', 'off', 'starting', 'failed', 'absent'] as const)
export type PolicyJobState = typeof policyJobStates[number]

// A plugin's lifecycle state, which the plugins manager owns
export const pluginStates = frozen([
  'found', 'refused', 'waiting', 'off', 'starting', 'ready', 'unresponsive', 'stopping', 'stopped', 'crashed', 'failed',
] as const)
export type PluginState = typeof pluginStates[number]

// A plugin as a call target. actions are the manifest's provides.actions and serves is the half that answers them.
// topics are the manifest's provides.topics, each published as <id>.<name>, which the bus reads
export type PluginInfo = {
  state: PluginState
  place: 'host' | 'utility' | 'sandboxed'
  incarnation: number
  serves: string
  actions: Readonly<Record<string, { readonly from?: readonly string[] }>>
  topics: readonly string[]
}

type LimitValues = Readonly<Partial<Record<LimitName, number>>>

// The human's limits from the state, a value per constant for all plugins and per plugin. A value replaces the fixed
// value whether it raises or lowers it. One for the plugin wins over one for all
export type HumanLimits = { all: LimitValues, plugins: Readonly<Record<string, LimitValues>> }

// The plugins manager's state as the router reads it, on each call and with no copy. Read only: nothing here changes a
// plugin, a policy job or the grants snapshot
export type PluginTable = {
  // The state of a policy job or a guard role, as the core module holding it reads
  policyJob(id: string): PolicyJobState
  // The number of the newest grants snapshot pushed to the gate
  view(): number
  // null for no such plugin
  plugin(id: string): PluginInfo | null
  limits(): HumanLimits
}

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
  gate: PolicyJobState
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

