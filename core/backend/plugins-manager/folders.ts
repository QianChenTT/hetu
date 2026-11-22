import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { pluginId } from '../../api/ids.ts'
import { retried, syncDir } from '../../lib/disk.ts'
import type { PluginFile } from '../../lib/hash-files.ts'
import { replaceFile } from '../../lib/hashed-file.ts'

// The plugins manager's folders in the data folder
export const folders = {
  plugins: (dataDir: string, id: string) => path.join(dataDir, 'plugins', id),
  staging: (dataDir: string) => path.join(dataDir, 'staging'),
  failedOnce: (dataDir: string) => path.join(dataDir, 'failed-once'),
  starting: (dataDir: string) => path.join(dataDir, 'starting'),
  cache: (dataDir: string, id: string) => path.join(dataDir, 'cache', id),
  storage: (dataDir: string, id: string) => path.join(dataDir, 'storage', id),
}

const token = () => randomBytes(8).toString('hex')

// What an older build kept in the data folder that nothing reads now: installed.json, each core plugin's version and
// hash. The first start takes it away
const RETIRED = ['installed.json']

export async function dropRetired(dataDir: string): Promise<void> {
  for (const name of RETIRED) await retried(() => rm(path.join(dataDir, name), { force: true }))
}

// Writes the files into a new folder in staging, outside plugins/, each one synced before the swap moves it
export async function stage(dataDir: string, id: string, files: readonly PluginFile[]): Promise<string> {
  const dir = path.join(folders.staging(dataDir), `${id}-${token()}`)
  const made = new Set<string>()
  try {
    await mkdir(dir, { recursive: true })
    made.add(dir)
    for (const file of files) {
      const target = path.join(dir, ...file.path.split('/'))
      const parent = path.dirname(target)
      if (!made.has(parent)) {
        await mkdir(parent, { recursive: true })
        made.add(parent)
      }
      const handle = await open(target, 'wx')
      try {
        await handle.writeFile(file.bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    for (const folder of made) await syncDir(folder)
    await syncDir(folders.staging(dataDir))
  } catch (err) {
    // A half-written copy left in staging is never read or run, the stage's own error goes up
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  return dir
}

// Puts a staged folder in place of plugins/<id>. The old folder moves out into staging first, so a crash leaves the old
// version, no folder or the new one, never a mix. The caller writes the entry after this, last. No target for the
// retry, which gives up at once on a folder and a folder is what moves here
export async function swapIn(dataDir: string, id: string, staged: string): Promise<void> {
  const target = folders.plugins(dataDir, id)
  await mkdir(path.dirname(target), { recursive: true })
  const old = path.join(folders.staging(dataDir), `${id}-old-${token()}`)
  let moved = false
  try {
    await retried(() => rename(target, old))
    moved = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  try {
    await retried(() => rename(staged, target))
  } catch (err) {
    // The old version back where it was, so a failed swap changes nothing
    // A restore that fails as well leaves no folder at plugins/<id> rather than a mix, the swap's error still goes up
    if (moved) await retried(() => rename(old, target)).catch(() => {})
    throw err
  }
  await syncDir(path.dirname(target))
  await syncDir(folders.staging(dataDir))
  // The old version left in staging is never read or run, the swap already landed
  if (moved) await rm(old, { recursive: true, force: true }).catch(() => {})
}

export async function clear(dir: string): Promise<void> {
  await retried(() => rm(dir, { recursive: true, force: true }))
}

// What failed while hetu ran, the log, written before hetu quits to start again. A run that finds it and meets a
// failure again stops in the stopped mode instead of restarting a second time. It can only hold hetu stopped, so it
// needs no hash. Only a clean Quit or the human's choice clears it
export async function readFailedOnce(dataDir: string): Promise<string | null> {
  try {
    const id = (await readFile(folders.failedOnce(dataDir), 'utf8')).trim()
    return id === 'log' || pluginId.safeParse(id).success ? id : null
  } catch {
    return null
  }
}

export async function writeFailedOnce(dataDir: string, id: string): Promise<void> {
  await replaceFile(folders.failedOnce(dataDir), id)
}

export async function clearFailedOnce(dataDir: string): Promise<void> {
  await retried(() => rm(folders.failedOnce(dataDir), { force: true }))
}

// A judging control's start marker, written and synced before its start, so a start that hangs main is caught at the
// next launch even after a force quit. Empty: it can only hold hetu in the fail-safe, so it needs no hash
export async function writeStartMarker(dataDir: string, id: string): Promise<void> {
  await mkdir(folders.starting(dataDir), { recursive: true })
  const handle = await open(path.join(folders.starting(dataDir), id), 'w')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDir(folders.starting(dataDir))
}

export async function clearStartMarker(dataDir: string, id: string): Promise<void> {
  await retried(() => rm(path.join(folders.starting(dataDir), id), { force: true }))
  await syncDir(folders.starting(dataDir))
}

// The controls among ids whose start marker a run left, in the order of ids. A name that is none of them is no marker
// and a folder that can't be read holds nothing back, since a marker only holds hetu in the fail-safe
export async function readStartMarkers(dataDir: string, ids: readonly string[]): Promise<string[]> {
  try {
    const names = await readdir(folders.starting(dataDir))
    return ids.filter(id => names.includes(id))
  } catch {
    return []
  }
}
