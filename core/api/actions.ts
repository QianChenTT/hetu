import { z } from 'zod'
import type { CapabilityType } from './capabilities.ts'
import { change } from './changes.ts'
import { token, type Caller } from './envelope.ts'
import { floorConstantNames } from './floor.ts'
import { coreNamespaces, localName, pluginId, qualifiedName } from './ids.ts'
import { frozen } from './plain.ts'
import { MAX_SCOPE_LENGTH, pathProblem } from './scope.ts'

// The core actions, the bus's events.* actions and the provider actions with their argument schemas. A plugin's own
// actions come from its manifest and their args stay opaque. ui.* comes with the runtime and the mount, so it has no
// action here yet. Each provider's own step settles its list: history, exec and net have none yet

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

// The topics the core sends, to windows only and never with a path: core.status says to read core.status again and
// core.security that a security change was applied
export const coreTopics = frozen(['core.status', 'core.security'] as const)
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
// leases, which the provider keys by the caller the carrier names. scope names the argument the raw scope comes from. A
// write stays one audit record and reads are coalesced
export type ProviderAction = {
  readonly capability: CapabilityType | null
  readonly args: z.ZodType
  readonly scope: 'path' | 'paths' | null
  readonly write: boolean
}

// Frozen one level down with no prototype. A deep freeze would reach into the schemas, which keep caches
function lookup<T extends object>(entries: Record<string, T>): Readonly<Record<string, T>> {
  for (const entry of Object.values(entries)) Object.freeze(entry)
  return Object.freeze(Object.assign(Object.create(null), entries))
}

const target = z.strictObject({ plugin: pluginId })

const coreTable = {
  // The caller as its way in names it
  'core.self': { from: 'any', args: nothing },
  // Only for a live call delivered to the caller on the same way in. Gives back the paths both the caller and the
  // call's own caller may read
  'core.filterReadable': {
    from: 'any',
    args: z.strictObject({ call: token, paths: z.array(readPath).max(MAX_FILTER_PATHS) }),
  },
  'security.request': { from: 'windows', args: z.strictObject({ change }) },
  // requestId is the request a needs-confirm refusal named
  'security.confirm': { from: 'trusted', args: z.strictObject({ requestId: token }) },
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

const providerTable = {
  'luoshu.read': { capability: 'luoshu.read', args: z.strictObject({ path }), scope: 'path', write: false },
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
  'log.history': { capability: 'log.read', args: nothing, scope: null, write: false },
  'log.verify': { capability: 'log.read', args: nothing, scope: null, write: false },
} satisfies Record<string, ProviderAction>
export const providerActions = lookup<ProviderAction>(providerTable)

// Each action's args as a caller writes them, from the literal tables before lookup widens their keys to strings
type ArgsOf<T extends Record<string, { readonly args: z.ZodType }>> = { [A in keyof T]: z.input<T[A]['args']> }
export type ActionArgs = ArgsOf<typeof coreTable> & ArgsOf<typeof eventTable> & ArgsOf<typeof providerTable>

// What an action answers with where that is settled: the carrier's own actions and the luoshu's, which keep the daemon's
// shape with version the SHA-256 hex of the note's bytes. Every other action answers unknown until its provider's step
export type ActionResults = {
  'core.self': Caller
  'core.filterReadable': string[]
  'events.subscribe': { standing: string[] }
  'events.unsubscribe': null
  'events.publish': null
  'luoshu.read': { text: string, version: string }
  'luoshu.write': { version: string }
}
export type ResultOf<A extends string> = A extends keyof ActionResults ? ActionResults[A] : unknown
