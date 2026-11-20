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

// The policy jobs the carrier asks, the gate and the grant risk classifier held by the core modules of the same id. The
// log is the core's own
export const policyJobIds = frozen(['gate', 'grant-risk-classifier'] as const)

// The core module or core plugin that serves each provider namespace
export const providers = table({
  luoshu: 'luoshu',
  leases: 'leases',
  history: 'history',
  exec: 'exec',
  storage: 'storage',
  cache: 'storage',
  net: 'net',
} as const)

// Served by the carrier, the plugins manager and the runtime, never by a plugin. log.* reads the event log the core writes
export const coreNamespaces = frozen(['core', 'security', 'events', 'ui', 'plugin', 'log', 'editor'] as const)

// The actions a guard may hook: each one that changes a note
export const guardableActions = frozen(['luoshu.write', 'luoshu.remove', 'luoshu.move'] as const)
export type GuardableAction = typeof guardableActions[number]

// The guards expected on each guardable action, in the order they answer. Empty until leases ships with #77, since an
// expected guard that isn't running refuses every write
export const guards: Readonly<Record<GuardableAction, readonly string[]>> = table({
  'luoshu.write': [], 'luoshu.remove': [], 'luoshu.move': [],
})

// The core modules whose switch is a security control's though they judge no call: flood control, which bounds what
// plugins and windows may cost main, recording, which keeps what happened and the security view, which holds each
// change that widens for the human's Confirm
export const guardingModuleIds = frozen(['flood-control', 'recording', 'security-view'] as const)

// The security controls: the policy job holders, every guard core/api expects and the guarding modules. Switching one
// off widens what plugins may do and is typed. The log is the core's own and the providers serve powers without
// limiting anyone, so neither is one
export function isSecurityControl(id: string): boolean {
  return (policyJobIds as readonly string[]).includes(id) || Object.values(guards).some(list => list.includes(id))
    || (guardingModuleIds as readonly string[]).includes(id)
}

// The core's own modules, bundled into main.js and held by the core alone: no install list entry, no hash check of
// their own and no incarnation. Each keeps its off switch in the state and its id reserved. The six from the merge
// start in this order, the ones after them have no start of their own
export const coreModuleIds = frozen(['gate', 'grant-risk-classifier', 'storage', 'luoshu', 'history', 'exec', 'flood-control', 'heartbeat', 'recording', 'security-view'] as const)
export type CoreModuleId = typeof coreModuleIds[number]

// Core plugins, which load only from the install: mcp-http-handler in a utility process and hidden-marks in the
// editor page. Leases and net are designed and not built
export const corePluginIds = frozen(['leases', 'mcp-http-handler', 'net', 'hidden-marks'] as const)

// Core plugins whose host entry runs in a utility process of its own and never in main: Node, no sandbox, none of
// main's environment and no data folder. The manifest still names a host entry and the caller stays its host half
export const utilityIds = frozen(['mcp-http-handler'] as const)

// First-party plugins in the plugin folder, layout among them as hetu's own look. A copy there keeps the id only with
// the reserved first-party signer and bytes equal to the install's copy, which the plugins manager checks
export const firstPartyIds = frozen(['mcp', 'git', 'search', 'file-explorer', 'artifacts', 'notify', 'layout'] as const)

const reserved = new Set<string>([
  ...coreNamespaces,
  ...Object.keys(providers),
  ...Object.values(providers),
  ...policyJobIds,
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
