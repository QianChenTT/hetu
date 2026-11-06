import { folderManifest, installManifest, MAX_MANIFEST_BYTES, supportsApi, type InstallManifest } from '../../api/manifest.ts'
import { hashFiles, readFiles, type PluginFile } from '../../lib/hash-files.ts'
import { parseStrict } from '../../lib/hashed-file.ts'

export const MANIFEST_FILE = 'hetu-plugin.json'

// What a read found wrong with the plugin itself, whatever the state says: files gone or unreadable, a manifest outside
// its schema, one that asks from the plugin folder for what only the install holds, one naming another id and an api
// range outside this core
export type ReadProblem = 'missing' | 'invalid' | 'install-only' | 'id' | 'api'

// One read of a plugin's folder: the bytes that will run, their hash and the manifest among them. hash is null only when
// the files couldn't be read. A folder manifest is kept in the install manifest's type, which holds every field it has
export type Read = {
  files: readonly PluginFile[]
  hash: string | null
  manifest: InstallManifest | null
  problem: ReadProblem | null
}

export const unread: Read = Object.freeze({ files: Object.freeze([]), hash: null, manifest: null, problem: 'missing' })

// Every file a manifest names as an entry
export function entryPaths(manifest: InstallManifest): string[] {
  const { worker, frames, host, page } = manifest.entries
  return [worker, host, page, ...Object.values(frames ?? {})].filter((entry): entry is string => typeof entry === 'string')
}

function manifestOf(files: readonly PluginFile[], id: string, from: 'install' | 'folder'): Pick<Read, 'manifest' | 'problem'> {
  const file = files.find(candidate => candidate.path === MANIFEST_FILE)
  if (file === undefined || file.bytes.length > MAX_MANIFEST_BYTES) return { manifest: null, problem: 'invalid' }
  let manifest: InstallManifest
  try {
    manifest = parseStrict(file.bytes, from === 'install' ? installManifest : folderManifest)
  } catch {
    // A folder manifest the install's schema takes asks for a host or page entry, guards, Node built-ins or an
    // install-only type, none of which a plugin-folder plugin may hold
    if (from === 'folder') {
      try {
        parseStrict(file.bytes, installManifest)
        return { manifest: null, problem: 'install-only' }
      } catch {}
    }
    return { manifest: null, problem: 'invalid' }
  }
  // The state's id wins, so a manifest naming another one is refused rather than believed
  if (manifest.id !== id) return { manifest, problem: 'id' }
  if (!supportsApi(manifest.api)) return { manifest, problem: 'api' }
  // Entry paths resolve only against the hashed file map
  const held = new Set(files.map(candidate => candidate.path))
  if (!entryPaths(manifest).every(entry => held.has(entry))) return { manifest, problem: 'invalid' }
  return { manifest, problem: null }
}

// Reads each file of the folder once and keeps the bytes, which are the bytes that run (threat row 26). The manifest is
// parsed from those same bytes with the strict parser
export async function readPlugin(root: string, id: string, from: 'install' | 'folder'): Promise<Read> {
  let files: PluginFile[]
  let hash: string
  try {
    files = await readFiles(root)
    hash = hashFiles(files)
  } catch {
    return unread
  }
  return { files, hash, ...manifestOf(files, id, from) }
}
