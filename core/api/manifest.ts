import { z } from 'zod'
import { capabilities, folderCapabilities, screenText, text } from './capabilities.ts'
import { guardableActions, localName, MAX_NAME_LENGTH, pluginId } from './ids.ts'
import { plain, table } from './plain.ts'
import { pathProblem } from './scope.ts'
import { themeSpec } from './ui.ts'

// The core API's major version. A manifest whose api range leaves this version out still parses and is refused with
// api, not invalid. Version 2 renamed the ui items to ui.view and ui.layout and added views and themes
export const API_VERSION = 2

// What each major did to the one before it: the capability types it added, removed and reshaped, and whether a core
// action, a bridge verb or an event lost or changed a field. A narrower rule on who may call what is no change here,
// since an older plugin then meets a refusal and never a wider reach. A new major gets its record here
export type ApiChange = {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly reshaped: readonly string[]
  readonly actionsChanged: boolean
}

export const apiChanges: Readonly<Record<number, ApiChange>> = table({
  2: { added: ['ui.view', 'ui.layout'], removed: ['ui.panel', 'ui.statusBar'], reshaped: [], actionsChanged: true },
})
// hetu-plugin.json is refused unread past this size. The schema holds the parsed value to the same cap
export const MAX_MANIFEST_BYTES = 64 * 1024
// Entries in any other list or map of a manifest
export const MAX_LIST = 64

// This major, or an older one every major since only added to. named is the capability types the manifest asks for:
// one a later major added needs that major, and one a later major removed or reshaped would be read under a meaning
// its author never saw, so either refuses
export function supportsApi(range: string, named: readonly string[] = [], current = API_VERSION, changes = apiChanges): boolean {
  if (!/^\^(?:0|[1-9][0-9]*)$/.test(range)) return false
  const major = Number(range.slice(1))
  if (major === current) return true
  if (major < 1 || major > current) return false
  for (let next = major + 1; next <= current; next++) {
    const change = Object.hasOwn(changes, next) ? changes[next] : undefined
    if (change === undefined || change.actionsChanged) return false
    if (named.some(type => [change.added, change.removed, change.reshaped].some(listed => listed.includes(type)))) return false
  }
  return true
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

// The views a plugin declares, so a layout can place them and the views menu can list them before the plugin starts
export const MAX_VIEWS = 16
export const MAX_VIEW_TITLE = 64
// Pixels along the axis a view's region splits
export const MAX_VIEW_SIZE = 4096
const pixels = z.int().min(0).max(MAX_VIEW_SIZE)
const icon = entryPath.refine(value => /\.(?:svg|png)$/.test(value), 'an svg or png file')

export const viewSpec = z.strictObject({
  title: screenText(MAX_VIEW_TITLE),
  // view is a pane or a tab, item a small one for a status row or toolbar. The kinds grow only with a core API version
  kind: z.enum(['view', 'item']),
  icon: icon.optional(),
  size: z.strictObject({ min: pixels.optional(), preferred: pixels.optional(), max: pixels.optional() })
    .refine(({ min, preferred, max }) => {
      const set = [min, preferred, max].filter((value): value is number => value !== undefined)
      return set.every((value, at) => at === 0 || value >= (set[at - 1] as number))
    }, 'min, preferred and max out of order')
    .optional(),
  // Orders only views the human never touched
  priority: z.int().min(0).max(100).optional(),
  // A frame entry draws it in place of a tree
  frame: frameName.optional(),
})
export type ViewSpec = z.infer<typeof viewSpec>

const views = map(localName, viewSpec).refine(entries => Object.keys(entries).length <= MAX_VIEWS, `more than ${MAX_VIEWS} views`)

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
  views: views.optional(),
  // Token values only, picked by the human apart from the layout. A theme needs no grant
  theme: themeSpec.optional(),
}

// A view drawn by a frame names one of the plugin's own frame entries
type Drawn = { entries: { frames?: Record<string, string> | undefined }, views?: Record<string, ViewSpec> | undefined }
function framesHeld(manifest: Drawn): boolean {
  const frames = manifest.entries.frames ?? {}
  return Object.values(manifest.views ?? {}).every(view => view.frame === undefined || Object.hasOwn(frames, view.frame))
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
  ).refine(framesHeld, 'a view whose frame is no frame entry'),
  MAX_MANIFEST_BYTES,
)
export type InstallManifest = z.infer<typeof installManifest>

// A manifest from the plugin folder. Every install-only field is unknown here and refused like any other
export const folderManifest = plain(
  z.strictObject({
    ...common,
    entries: z.strictObject(folderEntries).refine(someEntry, 'no entry'),
    capabilities: folderCapabilities.optional(),
  }).refine(framesHeld, 'a view whose frame is no frame entry'),
  MAX_MANIFEST_BYTES,
)
export type FolderManifest = z.infer<typeof folderManifest>
