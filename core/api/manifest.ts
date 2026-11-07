import { z } from 'zod'
import { capabilities, folderCapabilities, text } from './capabilities.ts'
import { guardableActions, localName, MAX_NAME_LENGTH, pluginId } from './ids.ts'
import { plain } from './plain.ts'
import { pathProblem } from './scope.ts'

// The core API's major version. A manifest whose api range leaves this version out still parses and is refused with
// api, not invalid
export const API_VERSION = 1
// hetu-plugin.json is refused unread past this size. The schema holds the parsed value to the same cap
export const MAX_MANIFEST_BYTES = 64 * 1024
// Entries in any other list or map of a manifest
export const MAX_LIST = 64

export function supportsApi(range: string): boolean {
  return range === `^${API_VERSION}`
}

// A file in the plugin's own folder, resolved only against the hashed file map
const entryPath = z.string().superRefine((value, ctx) => {
  const problem = pathProblem(value)
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem })
})

function list<T extends z.ZodType>(item: T) {
  return z.array(item).max(MAX_LIST)
}

// Comes out with no prototype, so a name the author never declared, toString or hasOwnProperty included, finds nothing
function map<K extends z.ZodType<string>, V extends z.ZodType>(key: K, value: V) {
  return z.record(key, value)
    .refine(entries => Object.keys(entries).length <= MAX_LIST, `more than ${MAX_LIST} entries`)
    .transform(entries => Object.assign(Object.create(null), entries) as typeof entries)
}

// A frame's name is the name of that frame's half, so no frame can take the name of another half
const frameName = localName.refine(name => name !== 'worker' && name !== 'host' && name !== 'page', 'the name of another half')
// No version ranges in v1, everything ships together
const version = z.string().max(MAX_NAME_LENGTH, { abort: true }).regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/)
const builtin = z.string().max(MAX_NAME_LENGTH, { abort: true }).regex(/^[a-z][a-z0-9_]*(?:\/[a-z][a-z0-9_]*)*$/)

const folderEntries = { worker: entryPath.optional(), frames: map(frameName, entryPath).optional() }
const installEntries = { ...folderEntries, host: entryPath.optional(), page: entryPath.optional() }

// A frames map counts only with a frame in it, an empty one gives the plugin nothing to run
function someEntry(entries: Record<string, unknown>): boolean {
  return Object.values(entries).some(entry => {
    if (typeof entry === 'string') return true
    return typeof entry === 'object' && entry !== null && Object.keys(entry).length > 0
  })
}

// Written by the author and untrusted. Never the class, the signer, the tier or anything about another plugin beyond
// requires and plugin.call targets. Identity comes from the state, the id here only has to agree with the state
const common = {
  id: pluginId,
  name: text,
  version,
  api: z.string().regex(/^\^(?:0|[1-9][0-9]{0,5})$/),
  requires: list(pluginId).optional(),
  provides: z.strictObject({
    // Each called as <id>.<name>, from limits which plugins may
    actions: map(localName, z.strictObject({ from: list(pluginId).optional() })).optional(),
    topics: list(localName).optional(),
  }).optional(),
}

// A manifest from the install, where host and page entries, guards, the Node built-ins and install-only types may
// appear
export const installManifest = plain(
  z.strictObject({
    ...common,
    entries: z.strictObject(installEntries).refine(someEntry, 'no entry'),
    capabilities: capabilities.optional(),
    guards: list(z.enum(guardableActions)).optional(),
    node: list(builtin).optional(),
  }).refine(
    manifest => !manifest.guards?.length || manifest.capabilities?.some(granted => granted.type === 'guard.hook'),
    'guards without guard.hook',
  ),
  MAX_MANIFEST_BYTES,
)
export type InstallManifest = z.infer<typeof installManifest>

// A manifest from the plugin folder. Every install-only field is unknown here and refused like any other
export const folderManifest = plain(
  z.strictObject({
    ...common,
    entries: z.strictObject(folderEntries).refine(someEntry, 'no entry'),
    capabilities: folderCapabilities.optional(),
  }),
  MAX_MANIFEST_BYTES,
)
export type FolderManifest = z.infer<typeof folderManifest>
