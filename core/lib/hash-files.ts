import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { retried } from './disk.ts'

// One file of a plugin's folder. path joins the names with / on every platform
export type PluginFile = { path: string, bytes: Buffer }

async function listFiles(dir: string, prefix: string, files: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name
    if (entry.isDirectory()) await listFiles(path.join(dir, entry.name), `${rel}/`, files)
    else if (entry.isFile()) files.push(rel)
    else throw new Error(`not a file or folder: ${rel}`) // a link would pull in bytes from outside the plugin
  }
}

// Reads each file once, in the order the hash takes. The bytes that come back are the bytes to run, so nothing can
// swap a file between the hash and the load
export async function readFiles(root: string): Promise<PluginFile[]> {
  const stat = await lstat(root)
  if (!stat.isDirectory()) throw new Error('plugin folder is not a folder')
  const names: string[] = []
  await listFiles(root, '', names)
  const files: PluginFile[] = []
  for (const rel of names.sort()) {
    const file = path.join(root, rel)
    files.push({ path: rel, bytes: await retried(() => readFile(file), file, 'read') })
  }
  return files
}

// Path and size frame each file, so moving bytes across a file boundary changes the hash. Sorted by code unit, not in
// the order a file system lists. A path twice is refused, no folder holds one
export function hashFiles(files: readonly PluginFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const digest = createHash('sha256')
  for (const [i, file] of sorted.entries()) {
    if (i > 0 && sorted[i - 1].path === file.path) throw new Error(`a file twice: ${file.path}`)
    digest.update(`${file.path}\0${file.bytes.length}\0`).update(file.bytes)
  }
  return digest.digest('hex')
}
