import { z } from 'zod'
import { MAX_SCOPES_PER_TYPE, screenText, text, type Capability, type CapabilityType } from './capabilities.ts'
import { askedCapability, change, clientName, MAX_ASK_ITEMS, MAX_CLIENT_ID_LENGTH, MAX_REDIRECT_LENGTH, type ChangeKind } from './changes.ts'
import { label, token, type Caller } from './envelope.ts'
import { MAX_COMMIT_MESSAGE, MAX_COMMIT_PATHS, MAX_LOG_PAGE } from './exec.ts'
import type { LimitName } from './limits.ts'
import { coreNamespaces, localName, MAX_ID_LENGTH, pluginId, qualifiedName } from './ids.ts'
import { bindFailures } from './lifecycle.ts'
import { frozen } from './plain.ts'
import { hidesOnScreen, isDotName, MAX_SCOPE_LENGTH, pathProblem } from './scope.ts'
import type { ViewSpec } from './manifest.ts'
import type { LogSegment, LogVerification, PluginState, PolicyJobState } from './policy-jobs.ts'
import type { ThemeSpec } from './ui.ts'

// The core actions, the bus's events.* actions and the provider actions with their argument schemas. A plugin's own
// actions come from its manifest and their args stay opaque. ui.* comes with the runtime and the drawer, so it has no
// action here yet. Each provider's own step settles its list: net has none yet

// Why a path no action takes, or null: a spelling no canonical path holds, or a dot segment, which names no note. The
// one definition of both, read by the path schema and by the core's own publish, which no schema checks.
// gate.filterReadable drops a path it names from its answer
export function actionPathProblem(value: string): string | null {
  return pathProblem(value) ?? (value.split('/').some(isDotName) ? 'a dot segment' : null)
}

// A path as the caller wrote it, for every action. The matcher judges this text at precheck and the provider's prepare
// canonicalises it. A spelling no canonical path holds or a dot segment is refused here, so it answers invalid before
// precheck could answer not-granted whatever the gate's state. A caller can so tell its own bad spelling from a
// missing grant. Shape reads only the caller's own text
const path = z.string().min(1).max(MAX_SCOPE_LENGTH).superRefine((value, ctx) => {
  const problem = actionPathProblem(value)
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem })
})
// A path a callee read, which a link in the luoshu can give a name outside the grammar. filterReadable drops such a path
// rather than failing the call, since it matches no grant
const readPath = z.string().min(1).max(MAX_SCOPE_LENGTH)
const nothing = z.strictObject({}).optional()
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

// Paths gate.filterReadable takes in one call
export const MAX_FILTER_PATHS = 1024
// Paths one lock.set, lock.clear or lock.held names
export const MAX_LOCK_PATHS = 64
// Topics one subscribe or unsubscribe names. A half holds at most topicsPerHalf in all
export const MAX_CALL_TOPICS = 64

// The topics the core sends, to windows only and never with a path: core.status says to read core.status again,
// core.security that a security change was applied and core.quitting that hetu ends after a short grace, so a window can
// keep a draft
export const coreTopic = frozen({ status: 'core.status', security: 'core.security', quitting: 'core.quitting' } as const)
export const coreTopics = frozen(Object.values(coreTopic))
export type CoreTopic = typeof coreTopics[number]

// A topic a subscriber names: one the core sends or a plugin's <id>.<name>. The core's other namespaces carry no
// topic. events.dropped and events.ended reach every subscriber unasked
const topic = qualifiedName.refine(name => {
  const namespace = name.slice(0, name.indexOf('.'))
  if (namespace === 'core') return (coreTopics as readonly string[]).includes(name)
  return !(coreNamespaces as readonly string[]).includes(namespace)
}, 'not a topic')
const topics = z.strictObject({ topics: z.array(topic).min(1).max(MAX_CALL_TOPICS) })

// Who may call a core action: any caller, a hetu window, the trusted window, a plugin's host half in its utility
// process or the plugin the root of a chain called, under that call, when the chain carries a pair. The floor decides
// these and never the gate, so a failed gate can't block the way out. A value the floor has no rule for refuses every
// caller
export type CoreFrom = 'any' | 'windows' | 'trusted' | 'utility' | 'pair'

// Why a utility half refused a request at its door, the only reasons core.refused takes: the Host, an Origin or a
// Sec-Fetch-Site, the route or method, a size, the rate, the token, bytes or headers that don't parse and a request
// too slow
export const refusedReasons = frozen(['host', 'origin', 'method', 'size', 'rate', 'token', 'malformed', 'timeout'] as const)
export type RefusedReason = typeof refusedReasons[number]
// The most refusals one report counts, far above what a door can refuse in the second a report covers
export const MAX_REFUSAL_COUNT = 1_000_000
// The most fields one core.identities call names
export const MAX_FIELDS_ASKED = 64
// reads: the trusted window may send it inside its input delay, since it only reads. Anything else the trusted window
// sends then counts for nothing, a Confirm or a request that applies at once with confirmOff on. live: args.call names a
// live call delivered to the caller on the same way in, which the part serving the action gets a view of
export type CoreAction = { readonly from: CoreFrom, readonly args: z.ZodType, readonly reads?: true, readonly live?: true }

// A provider action. capability null is a free action: the caller's own storage and cache and clearing locks, which the
// provider keys by the caller the router names, and a listing. scope names the argument the raw
// scope comes from, ends a move's from and to in that order. access is what a history action does with its paths,
// which the router puts in the scope itself. also is a second requirement on some of the ends, judged at both stages
// like the first and on the ends prepare gave at decide. A write stays one audit record and reads are coalesced.
// filter list keeps only the result's paths the gate's canList allows
export type ProviderAction = {
  readonly capability: CapabilityType | null
  readonly args: z.ZodType
  readonly scope: 'path' | 'paths' | 'ends' | 'command' | null
  readonly access?: 'read' | 'commit'
  readonly also?: { readonly capability: CapabilityType, readonly ends: readonly End[] }
  readonly write: boolean
  readonly filter?: 'list'
}

// A move's two ends, in the order its raw and canonical scopes hold them
export const ends = frozen(['from', 'to'] as const)
export type End = typeof ends[number]

// The most names one luoshu.list call looks at, so no listing costs the gate and main more than this
export const LIST_PAGE = 1000

// Frozen one level down with no prototype. A deep freeze would reach into the schemas, which keep caches
function lookup<T extends object>(entries: Record<string, T>): Readonly<Record<string, T>> {
  for (const entry of Object.values(entries)) Object.freeze(entry)
  return Object.freeze(Object.assign(Object.create(null), entries))
}

const target = z.strictObject({ plugin: pluginId })
// A frame entry's name, which is never the name of another half
const frameName = localName.refine(name => name !== 'worker' && name !== 'host' && name !== 'page', 'the name of another half')
// A frame's single-use URL as main minted it: the views host, a token of 32 hex digits, then a path in the plugin
export const FRAME_TOKEN = /^[0-9a-f]{32}$/
const frameUrl = z.string().max(MAX_SCOPE_LENGTH).regex(/^hetu:\/\/views\/[0-9a-f]{32}\/[a-z0-9/._-]*$/)

const coreTable = {
  // The caller as its way in names it
  'core.self': { from: 'any', args: nothing, reads: true },
  // Only for a live call delivered to the caller on the same way in. Gives back the paths both the caller and the
  // call's own caller may read, never one actionPathProblem refuses, a dot segment among them, gate on or off
  'gate.filterReadable': {
    from: 'any',
    args: z.strictObject({ call: token, paths: z.array(readPath).max(MAX_FILTER_PATHS) }),
    reads: true,
    live: true,
  },
  // What a window's banner shows, read again whenever core.status is sent
  'core.status': { from: 'windows', args: nothing, reads: true },
  // The event log the core writes: each file's chain as history reads it and whether the open file checks out. A
  // window only, until the first-party shipper, which log.read is kept for
  'log.segments': { from: 'windows', args: nothing, reads: true },
  'log.verify': { from: 'windows', args: nothing, reads: true },
  'security.request': { from: 'windows', args: z.strictObject({ change }) },
  // requestId is the request a needs-confirm refusal or a request named. typed is what the human typed to prove
  // attention, which the core checks where the change asks for it
  'security.confirm': { from: 'trusted', args: z.strictObject({ requestId: token, typed: z.string().max(MAX_ID_LENGTH).optional() }) },
  'security.cancel': { from: 'trusted', args: z.strictObject({ requestId: token }) },
  // Opens the trusted window, at the named request or else at the plugin list, and focuses one already open. Only a
  // human's click on a core control sends it, a notice's included
  'app.openSecurity': { from: 'windows', args: z.strictObject({ requestId: token.optional() }).optional() },
  // What the trusted window draws: the plugin list, the switches, the requests waiting and the stopped mode
  'security.list': { from: 'trusted', args: nothing, reads: true },
  // The human's stop of a sandboxed plugin, from the plugin list only. A restart widens nothing, so any window may
  'core.stop': { from: 'trusted', args: target },
  'core.restart': { from: 'windows', args: target },
  'app.quit': { from: 'windows', args: nothing },
  'app.relaunch': { from: 'trusted', args: nothing },
  // The OS folder dialog over the trusted window, answering the folder picked or null. The page then asks for luoshu.pick,
  // which waits for the Confirm
  'app.pickFolder': { from: 'trusted', args: nothing },
  // What a plugin may do with one note through the editor bridge, from the gate: read it, write it and which ui items
  // it holds. The drawer asks before it serves a plugin anything about an open note. With no path, the ui items alone
  'gate.reach': { from: 'windows', args: z.strictObject({ plugin: pluginId, path: path.optional() }), reads: true },
  // Each plugin's declared views and theme with whether it runs, which the drawer reads again on core.status and
  // core.security
  'core.views': { from: 'windows', args: nothing },
  // A single-use URL main serves one of a running plugin's frames from, out of the bytes it started with
  'editor.frame': { from: 'windows', args: z.strictObject({ plugin: pluginId, frame: frameName }) },
  // The frame at that URL is gone. navigated says it loaded again, which the core records
  'editor.frameGone': { from: 'windows', args: z.strictObject({ url: frameUrl, navigated: z.boolean() }) },
  // The refusals at the door since mcp-http-handler's last report for one reason, which the core writes as
  // <plugin id>.refused coalesced by reason
  'core.refused': {
    from: 'utility',
    args: z.strictObject({ reason: z.enum(refusedReasons), count: z.int().positive().max(MAX_REFUSAL_COUNT) }),
  },
  // mcp-http-handler's bind on its port failed. The plugins manager ends the calling half with the reason and the plugin reads failed. It
  // names no plugin, so a half speaks only about itself
  'core.bindFailed': { from: 'utility', args: z.strictObject({ reason: z.enum(bindFailures) }) },
  // The plugin the root of a chain called asks the human for items for the chain's pair, read from the chain and never
  // from an argument. Answers at once: waiting for the human, or granted when the pair holds them all
  'core.identityAsk': { from: 'pair', args: z.strictObject({ capabilities: z.array(askedCapability).min(1).max(MAX_ASK_ITEMS) }) },
  // What a utility half asks the core about the pairs its plugin roots: for each field whether the pair holds items,
  // holds none or was revoked in this run
  'core.identities': { from: 'utility', args: z.strictObject({ fields: z.array(label).min(1).max(MAX_FIELDS_ASKED) }) },
  // A utility half asks the human to connect a client, which its calls then carry as field. The core raises the request
  // and answers at once with a handle it made, which the same plugin collects the answer with. Never a handle from the
  // plugin
  'core.consentAsk': {
    from: 'utility',
    args: z.strictObject({
      client: screenText(MAX_CLIENT_ID_LENGTH),
      name: clientName.nullable(),
      redirect: screenText(MAX_REDIRECT_LENGTH),
      field: label,
    }),
  },
  // The human's answer to the connect a handle names: waiting, yes or no, each of yes and no once, then gone
  'core.consentAnswer': { from: 'utility', args: z.strictObject({ handle: token }) },
} satisfies Record<string, CoreAction>
export const coreActions = lookup<CoreAction>(coreTable)

// The bus's actions, which the router serves itself. The floor decides who may name which topic and the gate judges a
// subscribe to another plugin's topics under events.subscribe, scoped by topics. A publish names one topic the
// caller's own manifest declared, with a path at most and never content. Acknowledging is the ack message, not a call.
// does is what the bus does with it. A subscribe names the capability the gate judges it under
export type EventAction = { readonly args: z.ZodType } & (
  | { readonly does: 'subscribe', readonly capability: CapabilityType }
  | { readonly does: 'unsubscribe' }
  | { readonly does: 'publish' }
)

const eventTable = {
  'events.subscribe': { args: topics, does: 'subscribe', capability: 'events.subscribe' },
  'events.unsubscribe': { args: topics, does: 'unsubscribe' },
  'events.publish': { args: z.strictObject({ topic: qualifiedName, path: path.optional() }), does: 'publish' },
} satisfies Record<string, EventAction>
export const eventActions = lookup<EventAction>(eventTable)
// The subscribe with the capability it is judged under, which the router asks the gate about again for every
// subscription the bus holds
const subscribeName = 'events.subscribe' satisfies keyof typeof eventTable
export const subscribeAction = frozen({ action: subscribeName, capability: eventTable[subscribeName].capability })

const key = z.strictObject({ key: localName })
const keyed = z.strictObject({ key: localName, value: z.unknown() })
// Line breaks and nothing else a screen could hide, since a window draws the message as it is. It reaches git on stdin
const commitMessage = z.string().min(1).max(MAX_COMMIT_MESSAGE, { abort: true })
  .refine(value => !hidesOnScreen(value.replaceAll('\n', '')), 'a character that could hide')
// A commit by its full id, never a name git would resolve
const commitId = z.string().regex(/^[0-9a-f]{40}$/)

const providerTable = {
  'luoshu.read': {
    capability: 'luoshu.read',
    args: z.strictObject({ path }),
    scope: 'path',
    write: false,
  },
  // The file paths under folder, the whole luoshu when it is left out, in name order after the one named, a page at a
  // time. A caller sees the names it may list or read and never a version, which would say what a note holds
  'luoshu.list': {
    capability: null,
    args: z.strictObject({ folder: path.optional(), after: path.optional() }),
    scope: null,
    write: false,
    filter: 'list',
  },
  // baseVersion is the hash of the bytes the writer read, left out for a note that doesn't exist yet
  'luoshu.write': {
    capability: 'luoshu.write',
    args: z.strictObject({ path, text: z.string(), baseVersion: sha256.optional() }),
    scope: 'path',
    write: true,
  },
  // To the OS's bin. baseVersion is the hash of the bytes the remover read, and a note that moved on since answers
  // stale, so a plugin that writes a note and can't read it can't bin it any more than it can write over it
  'luoshu.remove': {
    capability: 'luoshu.write', args: z.strictObject({ path, baseVersion: sha256 }), scope: 'path', write: true,
  },
  // Never onto a note that exists. Write on both ends and read on the one it leaves, or a plugin that writes everywhere
  // could carry a note it can't read into a folder it reads
  'luoshu.move': {
    capability: 'luoshu.write',
    args: z.strictObject({ from: path, to: path }),
    scope: 'ends',
    also: { capability: 'luoshu.read', ends: ['from'] },
    write: true,
  },
  // Locks the notes at these paths for ms from now, so no other holder's write, remove or move reaches them. The holder
  // is the caller's own chain: the root plugin and the pair it carries, never a name in the arguments. Setting a lock
  // the caller already holds renews it. The lock module clamps ms to its cap
  'lock.set': {
    capability: 'lock.set',
    args: z.strictObject({ paths: z.array(path).min(1).max(MAX_LOCK_PATHS), ms: z.int().min(1) }),
    scope: 'paths',
    write: true,
  },
  // A plugin clears only the locks its own chain holds and a window any lock, the human taking a note over
  'lock.clear': { capability: null, args: z.strictObject({ paths: z.array(path).min(1).max(MAX_LOCK_PATHS) }), scope: null, write: true },
  // Which of these paths are locked, by anyone, never by whom. The caller reads every one
  'lock.held': {
    capability: 'luoshu.read', args: z.strictObject({ paths: z.array(path).min(1).max(MAX_LOCK_PATHS) }), scope: 'paths', write: false,
  },
  'storage.get': { capability: null, args: key, scope: null, write: false },
  'storage.set': { capability: null, args: keyed, scope: null, write: true },
  'storage.delete': { capability: null, args: key, scope: null, write: true },
  'cache.get': { capability: null, args: key, scope: null, write: false },
  'cache.set': { capability: null, args: keyed, scope: null, write: true },
  'cache.delete': { capability: null, args: key, scope: null, write: true },
  // The notes at these paths as they are now, into hetu's own history as one commit. A path with no note is recorded
  // as removed
  'history.commit': {
    capability: 'history',
    access: 'commit',
    args: z.strictObject({ paths: z.array(path).min(1).max(MAX_COMMIT_PATHS), message: commitMessage }),
    scope: 'paths',
    write: true,
  },
  // The commits that changed one note, newest first
  'history.log': {
    capability: 'history',
    access: 'read',
    args: z.strictObject({ path, limit: z.int().min(1).max(MAX_LOG_PAGE).optional() }),
    scope: 'path',
    write: false,
  },
  // One note's text as a commit holds it. A restore writes it back through luoshu.write
  'history.read': {
    capability: 'history', access: 'read', args: z.strictObject({ path, commit: commitId }), scope: 'path', write: false,
  },
  // One command as its argument array, which has to be one the caller's manifest declared. The caller gives no
  // environment, no working directory and no input
  'exec.run': {
    capability: 'exec', args: z.strictObject({ command: z.array(text).min(1).max(MAX_SCOPES_PER_TYPE) }), scope: 'command', write: true,
  },
} satisfies Record<string, ProviderAction>
export const providerActions = lookup<ProviderAction>(providerTable)

// Each action's args as a caller writes them, from the literal tables before lookup widens their keys to strings
type ArgsOf<T extends Record<string, { readonly args: z.ZodType }>> = { [A in keyof T]: z.input<T[A]['args']> }
export type ActionArgs = ArgsOf<typeof coreTable> & ArgsOf<typeof eventTable> & ArgsOf<typeof providerTable>

// A security change waiting for the human: its kind and the plugin it names or that raised it, null for a change no
// plugin is named in. A window draws it as a notice that opens the trusted window
export type PendingRequest = { id: string, kind: ChangeKind, plugin: string | null }

// Why hetu stopped: the install list didn't check out at start, a control that judges yes or no failed at start or the
// event log failed while hetu ran, with the lifecycle reason. again says the run before already restarted hetu after a
// failure, so it didn't restart a second time
export type StoppedMode = { control: string, why: 'tampered' | 'failed' | 'start-failed', reason: string | null, again: boolean }

// The reason of a control whose start marker the run before left: its start hung main and the run was ended
export const START_HUNG = 'start-hung'

// The words that name why hetu stopped, the same in the trusted window and in the native box
export function stoppedCause(mode: StoppedMode): string {
  if (mode.why === 'start-failed') return `hetu stopped: ${mode.control} failed at start`
  return mode.control === 'log' ? 'hetu stopped: the event log can’t write' : 'hetu stopped: its install list doesn’t check out'
}

// One plugin as the trusted window's plugin list shows it: where its code came from (the core's own modules, the install
// or the plugin folder) and where it runs (in the core, in main, in a utility process, in a sandboxed worker or in the
// editor page), its state and why, whether it is a security control, the human's switch and, for a plugin-folder
// plugin, each item it was granted
export type ListedPlugin = {
  id: string
  from: 'core' | 'install' | 'folder'
  place: 'core' | 'host' | 'utility' | 'sandboxed' | 'page'
  state: PluginState
  reason: string | null
  security: boolean
  // A plugin-folder copy of a first-party plugin, which Recover can restore from the install
  firstParty: boolean
  on: boolean
  items: { capability: Capability, off: boolean, firstUse: boolean }[]
  // The class the grant risk classifier policy job gave a plugin-folder plugin, null for none known, which counts as 4, and for a
  // core module or core plugin
  class: number | null
}

// A request waiting for the human in the core's own words, with the word to type where the change asks for one. root
// and field are the pair of an ask for a pair's items or the one a connect gives, the field in quotes in the text,
// both null for every other request
export type HeldRequest = PendingRequest & { text: string, notes: string[], type: string | null, root: string | null, field: string | null }

// One pair as the trusted window's identities list shows it, from what the plugins manager holds for the run: the root
// plugin's id, the field, the items and whether the human revoked it
export type ListedIdentity = { root: string, field: string, items: Capability[], revoked: boolean }

// What the trusted window draws: the plugin list, the switches that weaken a check, the requests waiting, oldest
// first, the identities and the stopped mode
export type SecurityList = {
  plugins: ListedPlugin[]
  switches: {
    devMode: string[]
    execAnyCommand: string[]
    skipVerification: boolean
    allowUnsigned: string[]
    confirmOff: boolean
  }
  // The values the human set, for all plugins and for each one. A constant not named runs at the fixed value
  limits: { all: Partial<Record<LimitName, number>>, plugins: Record<string, Partial<Record<LimitName, number>>> }
  // The notes folder, null for none picked
  luoshu: string | null
  requests: HeldRequest[]
  identities: ListedIdentity[]
  stopped: StoppedMode | null
}

// What a window's banner shows: each policy job's state, the plugins crashed, failed or unresponsive that nobody restarted, the
// switches that weaken a check, whether the event log takes appends, whether a luoshu folder is picked, the in-page
// plugins ready, the requests
// waiting for the human and the stopped mode
export type CoreStatus = {
  // The gate's and the grant risk classifier's states, each read from its module
  policyJobs: { readonly gate: PolicyJobState, readonly 'grant-risk-classifier': PolicyJobState }
  crashed: string[]
  devMode: string[]
  allowUnsigned: number
  skipVerification: boolean
  // The core modules the human switched off, in their order, each but a policy job, whose state shows already
  modulesOff: string[]
  logWrites: boolean
  luoshuPicked: boolean
  // The in-page core plugins that are ready, which the editor window applies: hidden-marks
  page: string[]
  pending: PendingRequest[]
  stopped: StoppedMode | null
  // The kinds of state file that failed their check at this start or went missing after an earlier run, never a path.
  // Empty once a start finds them all as written
  suspect: StateKind[]
}

export type StateKind = 'switches' | 'luoshu' | 'plugins'

// What an action answers with where that is settled: the router's own actions and the luoshu's, which keep the daemon's
// shape with version the SHA-256 hex of the note's bytes. Every other action answers unknown until its provider's step
export type ActionResults = {
  'core.self': Caller
  'core.status': CoreStatus
  'security.list': SecurityList
  'security.request': { applied: true } | { held: string }
  'gate.filterReadable': string[]
  'core.refused': null
  'core.bindFailed': null
  'core.identityAsk': { asked: 'waiting' | 'granted' }
  'core.identities': { field: string, holds: 'items' | 'none' | 'revoked' }[]
  'core.consentAsk': { handle: string }
  'core.consentAnswer': { answer: 'waiting' | 'yes' | 'no' | 'gone' }
  'log.segments': LogSegment[]
  'log.verify': LogVerification
  'events.subscribe': { standing: string[] }
  'events.unsubscribe': null
  'events.publish': null
  // path is where the note is, the canonical path the luoshu resolved and the gate judged, whatever the caller spelled
  'luoshu.read': { text: string, version: string, path: string }
  'luoshu.write': { version: string }
  'luoshu.remove': null
  'luoshu.move': null
  'luoshu.list': { paths: string[], next: string | null }
  // ms is the time the lock was set for, after the cap
  'lock.set': { ms: number }
  'lock.clear': null
  // The paths of the ones asked about that are locked, as the caller spelled them
  'lock.held': { paths: string[] }
  'app.pickFolder': string | null
  'gate.reach': { read: boolean, edit: boolean, uiRead: boolean, list: boolean, verbs: string[] }
  'core.views': { plugins: CoreViewsPlugin[] }
  'editor.frame': { url: string }
  'editor.frameGone': null
  // null when the notes hold nothing the last commit doesn't
  'history.commit': { commit: string | null }
  'history.log': { commits: HistoryCommit[] }
  'history.read': { text: string, version: string }
  'exec.run': ExecResult
}

// One commit as history.log lists it. author is who the change was made for, the caller's client when the call named
// one, and committer the caller that asked for the commit
export type HistoryCommit = { commit: string, author: string, committer: string, date: string, message: string }

// How a command ended: its exit code or the signal that ended it, with what it wrote as text. truncated says output
// past the cap was dropped
export type ExecResult = { code: number | null, signal: string | null, stdout: string, stderr: string, truncated: boolean }

// One plugin as core.views lists it: one that declares views or a theme, whatever its state
export type CoreViewsPlugin = {
  plugin: string
  name: string
  running: boolean
  // Whether it has a worker, which a view needs to draw
  worker: boolean
  views: Record<string, ViewSpec>
  theme: ThemeSpec | null
}
export type ResultOf<A extends string> = A extends keyof ActionResults ? ActionResults[A] : unknown
