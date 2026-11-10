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

// The policy slots the carrier asks, each held by the install plugin of the same id. The log is the core's own
export const slotIds = frozen(['gate', 'capabilities', 'watchdog'] as const)

// The plugin that serves each provider namespace
export const providers = table({
  luoshu: 'luoshu',
  leases: 'leases',
  history: 'history',
  exec: 'exec',
  storage: 'storage',
  cache: 'storage',
  net: 'net',
} as const)

// Served by the carrier, the loader and the runtime, never by a plugin. log.* reads the event log the core writes
export const coreNamespaces = frozen(['core', 'security', 'watchdog', 'events', 'ui', 'plugin', 'log', 'editor'] as const)

// The actions a guard may hook
export const guardableActions = frozen(['luoshu.write'] as const)
export type GuardableAction = typeof guardableActions[number]

// The guards expected on each guardable action, in the order they answer. Empty until leases ships with #77, since an
// expected guard that isn't running refuses every write
export const guards: Readonly<Record<GuardableAction, readonly string[]>> = table({ 'luoshu.write': [] })

// The security controls: the slot holders and every guard core/api expects. One that is on and fails stops hetu. The
// log is the core's own and the providers serve powers without limiting anyone, so neither is one
export function isSecurityControl(id: string): boolean {
  return (slotIds as readonly string[]).includes(id) || Object.values(guards).some(list => list.includes(id))
}

// The security controls an install holds, in the order they start. A control the install list doesn't name isn't
// part of the build
export function securityControls(listed: readonly string[]): string[] {
  const named = new Set(listed)
  return [...slotIds, ...new Set(Object.values(guards).flat())].filter(id => named.has(id))
}

// Host-level and in-page plugins, which load only from the install
export const installIds = frozen([
  'gate', 'capabilities', 'watchdog', 'storage', 'luoshu', 'leases', 'history', 'exec', 'http', 'net', 'hidden-marks',
] as const)

// First-party plugins in the plugin folder, layout among them as hetu's own look. A copy there keeps the id only with
// the reserved first-party signer and bytes equal to the install's copy, which the loader checks
export const firstPartyIds = frozen(['mcp', 'git', 'search', 'file-explorer', 'artifacts', 'notify', 'layout'] as const)

const reserved = new Set<string>([
  ...coreNamespaces,
  ...Object.keys(providers),
  ...Object.values(providers),
  ...slotIds,
  ...Object.values(guards).flat(),
  ...installIds,
  ...firstPartyIds,
])

// Ids a plugin-folder plugin can't take, apart from the first-party copies
export const reservedIds = frozen([...reserved].sort())

// Titles and owner strips in the editor window show a plugin by its id, so no plugin is called hetu
export function isReservedId(value: string): boolean {
  return reserved.has(value) || value === 'hetu' || value.startsWith('hetu-')
}
