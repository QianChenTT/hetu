import { doorId } from '../../api/ids.ts'
import { z } from 'zod'
import {
  API_VERSION, folderManifest, installManifest, MAX_MANIFEST_BYTES, supportsApi, typesRemovedAfter, type FolderManifest, type InstallManifest,
} from '../../api/manifest.ts'
import { hashFiles, readFiles, type PluginFile } from '../../lib/hash-files.ts'
import { parseStrict } from '../../lib/hashed-file.ts'

export const MANIFEST_FILE = 'hetu-plugin.json'

// What a read found wrong with the plugin itself, whatever the state says: files gone or unreadable, a manifest outside
// its schema, one that asks from the plugin folder for what only the install holds, one naming another id and an api
// range outside this core
export type ReadProblem = 'missing' | 'invalid' | 'install-only' | 'id' | 'api'

// One read of a plugin's folder: the bytes that will run, their hash and the manifest among them. hash is null only when
// the files couldn't be read. A folder manifest is kept in the install manifest's type, which holds every field it has.
// removedTypes is the types a major after the manifest's api range removed that it names, set aside from the manifest
// kept, empty for any other read
export type Read = {
  files: readonly PluginFile[]
  hash: string | null
  manifest: InstallManifest | null
  problem: ReadProblem | null
  removedTypes: readonly string[]
}

export const unread: Read = Object.freeze({ files: Object.freeze([]), hash: null, manifest: null, problem: 'missing', removedTypes: Object.freeze([]) })

// Every file a manifest names as an entry
export function entryPaths(manifest: InstallManifest): string[] {
  const { worker, frames, host } = manifest.entries
  return [worker, host, ...Object.values(frames ?? {})].filter((entry): entry is string => typeof entry === 'string')
}

// A manifest the folder schema refused, read again with the items set aside whose type a major after its api range
// removed. Null when the rest is still outside the schema, as it is when it names no such type
function manifestWithoutRemovedTypes(bytes: Buffer): { manifest: FolderManifest, removedTypes: string[] } | null {
  let value: unknown
  try {
    value = parseStrict(bytes, z.unknown())
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { api, capabilities } = value as { api?: unknown, capabilities?: unknown }
  if (typeof api !== 'string' || !Array.isArray(capabilities)) return null
  const removed = typesRemovedAfter(api)
  const typeOf = (item: unknown) => (typeof item === 'object' && item !== null ? (item as { type?: unknown }).type : undefined)
  const kept = capabilities.filter(item => !removed.some(type => type === typeOf(item)))
  const parsed = folderManifest.safeParse({ ...value, capabilities: kept })
  if (!parsed.success) return null
  return { manifest: parsed.data, removedTypes: removed.filter(type => capabilities.some(item => typeOf(item) === type)) }
}

function manifestOf(files: readonly PluginFile[], id: string): Pick<Read, 'manifest' | 'problem' | 'removedTypes'> {
  const file = files.find(candidate => candidate.path === MANIFEST_FILE)
  if (file === undefined || file.bytes.length > MAX_MANIFEST_BYTES) return { manifest: null, problem: 'invalid', removedTypes: [] }
  let manifest: InstallManifest
  try {
    manifest = parseStrict(file.bytes, folderManifest)
  } catch {
    // A folder manifest the core's own schema takes asks for a host or page entry, guards, Node built-ins or a type only
    // the core holds, none of which a plugin-folder plugin may hold
    try {
      parseStrict(file.bytes, installManifest)
      return { manifest: null, problem: 'install-only', removedTypes: [] }
    } catch {
      // A manifest neither schema takes is invalid, answered below
    }
    // One written for an older major, naming a type a later major removed, was written for an older hetu and is refused
    // api once the rest of it checks out. The manifest kept is the one read without those items, which go beside it
    const older = manifestWithoutRemovedTypes(file.bytes)
    if (older === null) return { manifest: null, problem: 'invalid', removedTypes: [] }
    return { ...older, problem: older.manifest.id === id ? 'api' : 'id' }
  }
  // The state's id wins, so a manifest naming another one is refused rather than believed
  if (manifest.id !== id) return { manifest, problem: 'id', removedTypes: [] }
  if (!supportsApi(manifest.api, (manifest.capabilities ?? []).map(granted => granted.type))) return { manifest, problem: 'api', removedTypes: [] }
  // Entry paths resolve only against the hashed file map
  const held = new Set(files.map(candidate => candidate.path))
  if (!entryPaths(manifest).every(entry => held.has(entry))) return { manifest, problem: 'invalid', removedTypes: [] }
  return { manifest, problem: null, removedTypes: [] }
}

// The file the build writes the door's code to, beside main.js
export const DOOR_FILE = 'door.js'

// The door's read: its code as built and the core's own record of it, never read from a file. One host entry run in a
// utility process, asking for nothing and requiring nothing
export function doorRead(bytes: Buffer): Read {
  const files = [{ path: DOOR_FILE, bytes }]
  const manifest: InstallManifest = { id: doorId, name: 'door', version: '1.0.0', api: `^${API_VERSION}`, entries: { host: DOOR_FILE } }
  return { files, hash: hashFiles(files), manifest, problem: null, removedTypes: [] }
}

// Reads each file of the folder once and keeps the bytes, which are the bytes that run (threat row 26). The manifest is
// parsed from those same bytes with the strict parser
export async function readPlugin(root: string, id: string): Promise<Read> {
  let files: PluginFile[]
  let hash: string
  try {
    files = await readFiles(root)
    hash = hashFiles(files)
  } catch {
    return unread
  }
  return { files, hash, ...manifestOf(files, id) }
}
