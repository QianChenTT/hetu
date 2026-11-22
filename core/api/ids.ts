import { z } from 'zod'
import { frozen, isBadKey, table } from './plain.ts'

export const MAX_ID_LENGTH = 64
export const MAX_NAME_LENGTH = 64
// <namespace>.<name> at the longest
export const MAX_QUALIFIED_LENGTH = MAX_ID_LENGTH + 1 + MAX_NAME_LENGTH

const id = '[a-z0-9]+(?:[_-][a-z0-9]+)*'
const name = '[a-z][a-zA-Z0-9]*'

// Becomes a folder name under plugins/ and the first part of every action and topic the plugin owns, so no separators
// and no dots, which keeps <id>.<name> splitting one way. Windows device names are refused on every platform, since
// tools such as PowerShell 5.1 can't delete such a folder. plain.ts refuses constructor and prototype as keys, so a map
// keyed by plugin id would refuse a plugin with one of them. Every other member of Object fails the grammar already
export const pluginId = z.string()
  .max(MAX_ID_LENGTH, { abort: true })
  .regex(new RegExp(`^${id}$`))
  .refine(value => !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value), 'a Windows device name')
  .refine(value => !isBadKey(value), 'a key plain data refuses')

// The name a plugin gives one of the plugin's own actions, topics or frames
export const localName = z.string().max(MAX_NAME_LENGTH, { abort: true }).regex(new RegExp(`^${name}$`))

// An action or a topic: a plugin id or a namespace the core serves, then a name. The first dot splits the two and
// the id and the name are each capped
export const qualifiedName = z.string()
  .max(MAX_QUALIFIED_LENGTH, { abort: true })
  .regex(new RegExp(`^${id}\\.${name}$`))
  .refine(value => {
    const dot = value.indexOf('.')
    return dot <= MAX_ID_LENGTH && value.length - dot - 1 <= MAX_NAME_LENGTH
  }, 'a part over its cap')

// How the router reaches the part serving a namespace. provider: a core module, or a core plugin in a utility process,
// through prepare and perform with the gate judging. action: an action of the core table, which the floor decides and
// never the gate. bus: the event bus inside the router. served: a part that keeps its own checks
export type Route = 'provider' | 'action' | 'bus' | 'served'

// A namespace's server: the part handed to the router under this name and the route to it. each: every call is an
// audit record of its own, never coalesced
export type Server = { readonly part: string, readonly route: Route, readonly each?: true }

// Every namespace the core keeps with its server, never a plugin. log.* reads the event log the core writes, ui.* is the
// drawer's and plugin names plugin.call, an action of none. Any other namespace is a plugin's id
export const namespaces = table({
  core: { part: 'plugins-manager', route: 'action' },
  security: { part: 'plugins-manager', route: 'action', each: true },
  events: { part: 'router', route: 'bus' },
  ui: { part: 'drawer', route: 'served' },
  plugin: { part: 'plugins-manager', route: 'action' },
  log: { part: 'recording', route: 'action' },
  editor: { part: 'runtime', route: 'action' },
  gate: { part: 'gate', route: 'action' },
  app: { part: 'runtime', route: 'action', each: true },
  luoshu: { part: 'luoshu', route: 'provider' },
  lock: { part: 'lock', route: 'provider' },
  history: { part: 'history', route: 'provider' },
  exec: { part: 'exec', route: 'provider' },
  storage: { part: 'storage', route: 'provider' },
  cache: { part: 'storage', route: 'provider' },
  net: { part: 'net', route: 'provider' },
} as const satisfies Record<string, Server>)
type Namespaces = typeof namespaces
// A part the router is handed under its name
export type Part = Namespaces[keyof Namespaces]['part']

// The server of a namespace, undefined for a plugin's id
export function serverOf(namespace: string): (Server & { readonly part: Part }) | undefined {
  return Object.hasOwn(namespaces, namespace) ? (namespaces as Readonly<Record<string, Server & { readonly part: Part }>>)[namespace] : undefined
}

type ProviderNamespace = { [N in keyof Namespaces]: Namespaces[N]['route'] extends 'provider' ? N : never }[keyof Namespaces]
// The core module or core plugin that serves each provider namespace, read from the table
export const providers = table(Object.fromEntries(Object.entries(namespaces).filter(([, server]) => server.route === 'provider')
  .map(([namespace, server]) => [namespace, server.part]))) as { readonly [N in ProviderNamespace]: Namespaces[N]['part'] }

// The namespaces the router and the parts handed to it serve, read from the table
export const coreNamespaces = frozen(Object.keys(namespaces).filter(namespace => serverOf(namespace)?.route !== 'provider'))

// The actions a guard may hook: each one that changes a note
export const guardableActions = frozen(['luoshu.write', 'luoshu.remove', 'luoshu.move'] as const)
export type GuardableAction = typeof guardableActions[number]

// The guards expected on each guardable action, in the order they answer: the lock module on each. An expected guard
// that isn't running refuses every write
export const guards: Readonly<Record<GuardableAction, readonly string[]>> = table({
  'luoshu.write': ['lock'], 'luoshu.remove': ['lock'], 'luoshu.move': ['lock'],
})

// The guard holding note locks. Its deny answers locked, any other guard's guard-refused
export const LOCK_GUARD = 'lock'

// The core modules that judge yes or no: the gate on every call and flood control on every message, which bounds what
// plugins and windows may cost main. With every guard core/api expects they are the security controls one rule holds:
// switched off by the human, the step is as if it didn't exist and answers yes
export const judgingModuleIds = frozen(['gate', 'flood-control'] as const)

// The core modules whose switch is a security control's though their answer is no plain yes or no: the grant risk
// classifier, which classes every plugin, recording, which keeps what happened and the security view, which holds each
// change that widens for the human's Confirm
export const guardingModuleIds = frozen(['grant-risk-classifier', 'recording', 'security-view'] as const)

// The core modules whose off widens though they are no security control: the heartbeat, off leaving a hang unwatched.
// Switching one off waits for one Confirm with no typed word and switching it on applies at once
export const watchingModuleIds = frozen(['heartbeat'] as const)

// The security controls: the judging modules, every guard core/api expects and the guarding modules. Switching one off
// widens what plugins may do and is typed. The log is the core's own and the providers serve powers without limiting
// anyone, so neither is one
export function isSecurityControl(id: string): boolean {
  return (judgingModuleIds as readonly string[]).includes(id) || Object.values(guards).some(list => list.includes(id))
    || (guardingModuleIds as readonly string[]).includes(id)
}

// The controls the fail-safe at start covers, each once: the judging modules and every guard expected on a guardable
// action. One that failed at start, hung main the run before or is missing without the human's switch stops hetu
// before any other module begins. The guarding modules are not among them, hetu starts on without them. guardsOf
// defaults to the guards table, tests name others
export function failSafeControls(guardsOf: (action: GuardableAction) => readonly string[] = action => guards[action]): readonly string[] {
  return frozen([...new Set<string>([...judgingModuleIds, ...guardableActions.flatMap(guardsOf)])])
}

// The core's own modules, bundled into main.js and held by the core alone: no install list entry, no hash check of
// their own and no incarnation. Each keeps its off switch in the state and its id reserved. The six from the merge
// start in this order, the ones after them have no start of their own. The fail-safe controls among them start first
export const coreModuleIds = frozen([
  'gate', 'grant-risk-classifier', 'storage', 'luoshu', 'history', 'exec', 'flood-control', 'heartbeat', 'recording', 'security-view', 'lock',
] as const)
export type CoreModuleId = typeof coreModuleIds[number]

// Core plugins, which load only from the install: mcp-http-handler in a utility process and hidden-marks in the
// editor page. net is designed and not built
export const corePluginIds = frozen(['mcp-http-handler', 'net', 'hidden-marks'] as const)

// Core plugins whose host entry runs in a utility process of its own and never in main: Node, no sandbox, none of
// main's environment and no data folder. The manifest still names a host entry and the caller stays its host half
export const utilityIds = frozen(['mcp-http-handler'] as const)

// First-party plugins in the plugin folder, layout among them as hetu's own look. A copy there keeps the id only with
// the reserved first-party signer and bytes equal to the install's copy, which the plugins manager checks
export const firstPartyIds = frozen(['mcp', 'git', 'artifacts', 'notify', 'layout'] as const)

const reserved = new Set<string>([
  ...coreNamespaces,
  ...Object.keys(providers),
  ...Object.values(providers),
  ...Object.values(guards).flat(),
  ...coreModuleIds,
  ...corePluginIds,
  ...firstPartyIds,
])

// Ids a plugin-folder plugin can't take, apart from the first-party copies
export const reservedIds = frozen([...reserved].sort())

// Titles and owner strips in the editor window show a plugin by its id, so no plugin is called hetu
export function isReservedId(value: string): boolean {
  return reserved.has(value) || value === 'hetu' || value.startsWith('hetu-')
}
