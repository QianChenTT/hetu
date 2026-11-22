import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { MANIFEST_FILE, readPlugin, type Read } from './verify.ts'

// A plugin found in a folder an install unpacked or the human picked: the folder, the id and version its manifest names
// and the read itself, whose files are the bytes to install and whose hash is theirs. id and version are null when no
// manifest could be read
export type Found = { folder: string, id: string | null, version: string | null, read: Read }

// A manifest that is no file, a link among them, holds no plugin. One that can't be looked at is no plugin either
const manifestIn = (folder: string) => lstat(path.join(folder, MANIFEST_FILE)).then(stat => stat.isFile(), () => false)

// The folder's name is no claim. A manifest naming another id is read again against that id, so the checks after the
// id's run on it too. A manifest changed between the two reads stays refused as id
async function readFound(folder: string): Promise<Found> {
  let read = await readPlugin(folder, path.basename(folder), 'folder')
  if (read.problem === 'id' && read.manifest !== null) read = await readPlugin(folder, read.manifest.id, 'folder')
  return { folder, id: read.manifest?.id ?? null, version: read.manifest?.version ?? null, read }
}

// The plugins in root: root itself when its manifest is at the top, else each folder one level down that holds one, in
// name order. A link is never followed, root included
export async function findPlugins(root: string): Promise<Found[]> {
  if (!(await lstat(root)).isDirectory()) return []
  if (await manifestIn(root)) return [await readFound(root)]
  const names = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  const found: Found[] = []
  for (const name of names) {
    const folder = path.join(root, name)
    if (await manifestIn(folder)) found.push(await readFound(folder))
  }
  return found
}
