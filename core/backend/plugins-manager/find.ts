import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isRealFolder } from './unpack.ts'
import { MANIFEST_FILE, readPlugin, type Read } from './verify.ts'

// A plugin found in a staging folder: the folder, the id and version its manifest names and the read itself, whose
// files are the bytes to install and whose hash is theirs. id and version are null when no manifest could be read, and
// are set for a read refused after the manifest parsed, so read.problem decides
export type Found = { folder: string, id: string | null, version: string | null, read: Read }

// not-a-folder: a root that is missing, a file or a link. same-id: two folders whose manifests name one id, which would
// land at one plugins/<id>. The plugins found are listed with it, so the human can be shown which
export type FindProblem = 'not-a-folder' | 'same-id'
export type Finding = { problem: FindProblem | null, plugins: Found[] }

// A manifest that is no file, a link among them, holds no plugin. One that can't be looked at is no plugin either
const manifestIn = (folder: string) => lstat(path.join(folder, MANIFEST_FILE)).then(stat => stat.isFile(), () => false)

// The folder's name is no claim. A manifest naming another id is read again against that id, so the checks after the
// id's run on it too. A manifest changed between the two reads stays refused as id
async function readFound(folder: string): Promise<Found> {
  let read = await readPlugin(folder, path.basename(folder))
  if (read.problem === 'id' && read.manifest !== null) read = await readPlugin(folder, read.manifest.id)
  return { folder, id: read.manifest?.id ?? null, version: read.manifest?.version ?? null, read }
}

// The plugins in a staging folder unpackZip or stageFolder filled under the caps, never a folder as picked: root itself
// when its manifest is at the top, else each folder one level down that holds one, in name order. A link is never
// followed, root included
export async function findPlugins(root: string): Promise<Finding> {
  if (!(await isRealFolder(root))) return { problem: 'not-a-folder', plugins: [] }
  if (await manifestIn(root)) return { problem: null, plugins: [await readFound(root)] }
  const names = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  const plugins: Found[] = []
  for (const name of names) {
    const folder = path.join(root, name)
    if (await manifestIn(folder)) plugins.push(await readFound(folder))
  }
  const ids = plugins.flatMap(found => (found.id === null ? [] : [found.id]))
  return { problem: new Set(ids).size < ids.length ? 'same-id' : null, plugins }
}
