import { z } from 'zod'
import { MAX_SCOPES_PER_TYPE, text, type Capability, type CapabilityType } from './capabilities.ts'
import { change, type ChangeKind } from './changes.ts'
import { token, type Caller } from './envelope.ts'
import { MAX_COMMIT_MESSAGE, MAX_COMMIT_PATHS, MAX_LOG_PAGE } from './exec.ts'
import { floorConstantNames, type FloorConstant } from './floor.ts'
import { coreNamespaces, localName, MAX_ID_LENGTH, pluginId, qualifiedName, type slotIds } from './ids.ts'
import { frozen } from './plain.ts'
import { hidesOnScreen, MAX_SCOPE_LENGTH, pathProblem } from './scope.ts'
import type { ViewSpec } from './manifest.ts'
import type { LogSegment, LogVerification, PluginState, SlotState } from './slots.ts'
import type { ThemeSpec } from './ui.ts'

// The core actions, the bus's events.* actions and the provider actions with their argument schemas. A plugin's own
// actions come from its manifest and their args stay opaque. ui.* comes with the runtime and the mount, so it has no
// action here yet. Each provider's own step settles its list: net has none yet

// A path as the caller wrote it. The matcher judges this text at precheck and the provider's prepare canonicalises it.
// A spelling no canonical path holds is refused here, so it answers invalid before precheck could answer not-granted
// and a caller can tell its own bad spelling from a missing grant. Shape reads only the caller's own text
const path = z.string().superRefine((value, ctx) => {
  const problem = pathProblem(value)
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem })
})
// A path a callee read, which a link in the luoshu can give a name outside the grammar. filterReadable drops such a path
// rather than failing the call, since it matches no grant
const readPath = z.string().min(1).max(MAX_SCOPE_LENGTH)
const nothing = z.strictObject({}).optional()
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

// Paths core.filterReadable takes in one call
export const MAX_FILTER_PATHS = 1024
// Paths one lease takes
export const MAX_LEASE_PATHS = 64
// Topics one subscribe or unsubscribe names. A half holds at most topicsPerHalf in all
export const MAX_CALL_TOPICS = 64

// The topics the core sends, to windows only and never with a path: core.status says to read core.status again,
// core.security that a security change was applied and core.quitting that hetu ends after a short grace, so a window can
// keep a draft
export const coreTopics = frozen(['core.status', 'core.security', 'core.quitting'] as const)
export type CoreTopic = typeof coreTopics[number]

// A topic a subscriber names: one the core sends or a plugin's <id>.<name>. The core's other namespaces carry no
// topic. events.dropped and events.ended reach every subscriber unasked
const topic = qualifiedName.refine(name => {
  const namespace = name.slice(0, name.indexOf('.'))
  if (namespace === 'core') return (coreTopics as readonly string[]).includes(name)
  return !(coreNamespaces as readonly string[]).includes(namespace)
}, 'not a topic')
const topics = z.strictObject({ topics: z.array(topic).min(1).max(MAX_CALL_TOPICS) })

// Who may call a core action: any caller, a hetu window, the trusted window or the watchdog slot's holder. The floor
// decides these and never the gate, so a failed gate can't block the way out
export type CoreFrom = 'any' | 'windows' | 'trusted' | 'watchdog'
export type CoreAction = { readonly from: CoreFrom, readonly args: z.ZodType }

// A provider action. capability null is a free action: the caller's own storage and cache and a lease holder's own
// leases, which the provider keys by the caller the carrier names, and a listing. scope names the argument the raw
// scope comes from. access is what a history action does with its paths, which the carrier puts in the scope itself.
// A write stays one audit record and reads are coalesced. filter list keeps only the result's paths the gate's canList
// allows
export type ProviderAction = {
  readonly capability: CapabilityType | null
  readonly args: z.ZodType
  readonly scope: 'path' | 'paths' | 'command' | null
  readonly access?: 'read' | 'commit'
  readonly write: boolean
  readonly filter?: 'list'
}

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
  'core.self': { from: 'any', args: nothing },
  // Only for a live call delivered to the caller on the same way in. Gives back the paths both the caller and the
  // call's own caller may read
  'core.filterReadable': {
    from: 'any',
    args: z.strictObject({ call: token, paths: z.array(readPath).max(MAX_FILTER_PATHS) }),
  },
  // What a window's banner shows, read again whenever core.status is sent
  'core.status': { from: 'windows', args: nothing },
  // The event log the core writes: each file's chain as history reads it and whether the open file checks out. A
  // window only, until the first-party shipper, which log.read is kept for
  'log.history': { from: 'windows', args: nothing },
  'log.verify': { from: 'windows', args: nothing },
  'security.request': { from: 'windows', args: z.strictObject({ change }) },
  // requestId is the request a needs-confirm refusal or a request named. typed is what the human typed to prove
  // attention, which the core checks where the change asks for it
  'security.confirm': { from: 'trusted', args: z.strictObject({ requestId: token, typed: z.string().max(MAX_ID_LENGTH).optional() }) },
  'security.cancel': { from: 'trusted', args: z.strictObject({ requestId: token }) },
  // Opens the trusted window, at the named request or else at the plugin list, and focuses one already open. Only a
  // human's click on a core control sends it, a notice's included
  'security.open': { from: 'windows', args: z.strictObject({ requestId: token.optional() }).optional() },
  // What the trusted window draws: the plugin list, the switches, the requests waiting and the stopped mode
  'security.list': { from: 'trusted', args: nothing },
  // The human's stop of a sandboxed plugin, from the plugin list only. A restart widens nothing, so any window may
  'core.stop': { from: 'trusted', args: target },
  'core.restart': { from: 'windows', args: target },
  'core.quit': { from: 'windows', args: nothing },
  'core.relaunch': { from: 'trusted', args: nothing },
  // The OS folder dialog over the trusted window, answering the folder picked or null. The page then asks for luoshu.set,
  // which waits for the Confirm
  'core.pickFolder': { from: 'trusted', args: nothing },
  // What a plugin may do with one note through the editor bridge, from the gate: read it, write it and which ui items
  // it holds. The drawer asks before it serves a plugin anything about an open note. With no path, the ui items alone
  'editor.reach': { from: 'windows', args: z.strictObject({ plugin: pluginId, path: path.optional() }) },
  // Each plugin's declared views and theme with whether it runs, which the drawer reads again on core.status and
  // core.security
  'core.views': { from: 'windows', args: nothing },
  // A single-use URL main serves one of a running plugin's frames from, out of the bytes it started with
  'editor.frame': { from: 'windows', args: z.strictObject({ plugin: pluginId, frame: frameName }) },
  // The frame at that URL is gone. navigated says it loaded again, which the floor records
  'editor.frameGone': { from: 'windows', args: z.strictObject({ url: frameUrl, navigated: z.boolean() }) },
  // Only on sandboxed plugins that hold no guard or slot role
  'watchdog.stop': { from: 'watchdog', args: target },
  'watchdog.restart': { from: 'watchdog', args: target },
  // Lowers one constant for one plugin. A value above the human's or the floor's own has no effect
  'watchdog.limit': {
    from: 'watchdog',
    args: z.strictObject({ plugin: pluginId, constant: z.enum(floorConstantNames), value: z.int().positive() }),
  },
} satisfies Record<string, CoreAction>
export const coreActions = lookup<CoreAction>(coreTable)

// The bus's actions, which the carrier serves itself. The floor decides who may name which topic and the gate judges a
// subscribe to another plugin's topics under events.subscribe, scoped by topics. A publish names one topic the
// caller's own manifest declared, with a path at most and never content. Acknowledging is the ack message, not a call
export type EventAction = { readonly args: z.ZodType }

const eventTable = {
  'events.subscribe': { args: topics },
  'events.unsubscribe': { args: topics },
  'events.publish': { args: z.strictObject({ topic: qualifiedName, path: path.optional() }) },
} satisfies Record<string, EventAction>
export const eventActions = lookup<EventAction>(eventTable)

const key = z.strictObject({ key: localName })
const keyed = z.strictObject({ key: localName, value: z.unknown() })
// Line breaks and nothing else a screen could hide, since a window draws the message as it is. It reaches git on stdin
const commitMessage = z.string().min(1).max(MAX_COMMIT_MESSAGE, { abort: true })
  .refine(value => !hidesOnScreen(value.replaceAll('\n', '')), 'a character that could hide')
// A commit by its full id, never a name git would resolve
const commitId = z.string().regex(/^[0-9a-f]{40}$/)

const providerTable = {
  'luoshu.read': { capability: 'luoshu.read', args: z.strictObject({ path }), scope: 'path', write: false },
  // The file paths under folder, the whole luoshu when it is left out, in name order after the one named, a page at a
  // time. A caller sees the names it may list or read and never a version, which would say what a note holds
  'luoshu.list': {
    capability: null, args: z.strictObject({ folder: path.optional(), after: path.optional() }), scope: null, write: false, filter: 'list',
  },
  // baseVersion is the hash of the bytes the writer read, left out for a note that doesn't exist yet
  'luoshu.write': {
    capability: 'luoshu.write',
    args: z.strictObject({ path, text: z.string(), baseVersion: sha256.optional() }),
    scope: 'path',
    write: true,
  },
  'leases.acquire': {
    capability: 'luoshu.write',
    args: z.strictObject({ paths: z.array(path).min(1).max(MAX_LEASE_PATHS) }),
    scope: 'paths',
    write: true,
  },
  'leases.renew': { capability: null, args: nothing, scope: null, write: true },
  'leases.release': { capability: null, args: nothing, scope: null, write: true },
  'leases.list': { capability: null, args: nothing, scope: null, write: false },
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

// Why hetu stopped instead of starting: a security control that is on failed its check, is missing from the install
// or failed at start, with the lifecycle reason. again says the run before already restarted hetu after a failure, so
// it didn't restart a second time
export type StoppedMode = { control: string, why: 'tampered' | 'absent' | 'failed', reason: string | null, again: boolean }

// One plugin as the trusted window's plugin list shows it: where its code came from and where it runs, its state and
// why, whether it is a security control, the human's switch and, for a plugin-folder plugin, each item it was granted
export type ListedPlugin = {
  id: string
  from: 'install' | 'folder'
  place: 'host' | 'sandboxed' | 'page'
  state: PluginState
  reason: string | null
  security: boolean
  // A plugin-folder copy of a first-party plugin, which Recover can restore from the install
  firstParty: boolean
  on: boolean
  items: { capability: Capability, off: boolean, firstUse: boolean }[]
  // The class the capabilities slot gave a plugin-folder plugin, null for none known, which counts as 4, and for an
  // install plugin
  class: number | null
}

// A request waiting for the human in the core's own words, with the word to type where the change asks for one
export type HeldRequest = PendingRequest & { text: string, notes: string[], type: string | null }

// What the trusted window draws: the plugin list, the switches that weaken a check, the requests waiting, oldest
// first, and the stopped mode
export type SecurityList = {
  plugins: ListedPlugin[]
  switches: {
    devMode: string[]
    execAnyCommand: string[]
    skipVerification: boolean
    allowUnsigned: string[]
    confirmOff: boolean
    recordNothing: boolean
  }
  // The values the human set, for all plugins and for each one. A constant not named runs at the floor's value
  limits: { all: Partial<Record<FloorConstant, number>>, plugins: Record<string, Partial<Record<FloorConstant, number>>> }
  // The notes folder, null for none picked
  luoshu: string | null
  requests: HeldRequest[]
  stopped: StoppedMode | null
}

// What a window's banner shows: each slot's state, the plugins crashed, failed or unresponsive that nobody restarted, the
// switches that weaken a check, whether the event log takes appends, whether a luoshu folder is picked, the in-page
// plugins ready, the requests
// waiting for the human and the stopped mode
export type CoreStatus = {
  slots: Record<typeof slotIds[number], SlotState>
  crashed: string[]
  devMode: string[]
  allowUnsigned: number
  skipVerification: boolean
  recordNothing: boolean
  logWrites: boolean
  luoshuPicked: boolean
  // The in-page install plugins that are ready, which the editor window applies: hidden-marks
  page: string[]
  pending: PendingRequest[]
  stopped: StoppedMode | null
  // The kinds of state file that failed their check at this start or went missing after an earlier run, never a path.
  // Empty once a start finds them all as written
  suspect: StateKind[]
}

export type StateKind = 'switches' | 'luoshu' | 'plugins'

// What an action answers with where that is settled: the carrier's own actions and the luoshu's, which keep the daemon's
// shape with version the SHA-256 hex of the note's bytes. Every other action answers unknown until its provider's step
export type ActionResults = {
  'core.self': Caller
  'core.status': CoreStatus
  'security.list': SecurityList
  'security.request': { applied: true } | { held: string }
  'core.filterReadable': string[]
  'log.history': LogSegment[]
  'log.verify': LogVerification
  'events.subscribe': { standing: string[] }
  'events.unsubscribe': null
  'events.publish': null
  'luoshu.read': { text: string, version: string }
  'luoshu.write': { version: string }
  'luoshu.list': { paths: string[], next: string | null }
  'core.pickFolder': string | null
  'editor.reach': { read: boolean, write: boolean, list: boolean, verbs: string[] }
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
