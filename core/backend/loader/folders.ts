import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { pluginId } from '../../api/ids.ts'
import { pluginVersion } from '../../api/install.ts'
import { retried, syncDir, writable } from '../../lib/disk.ts'
import type { PluginFile } from '../../lib/hash-files.ts'
import { checkHash, parseStrict, replaceFile, withHash } from '../../lib/hashed-file.ts'

// The loader's folders in the data folder, section 10's layout
export const folders = {
  plugins: (dataDir: string, id: string) => path.join(dataDir, 'plugins', id),
  staging: (dataDir: string) => path.join(dataDir, 'staging'),
  marker: (dataDir: string, id: string) => path.join(dataDir, 'starting', id),
  cache: (dataDir: string, id: string) => path.join(dataDir, 'cache', id),
  storage: (dataDir: string, id: string) => path.join(dataDir, 'storage', id),
  installed: (dataDir: string) => path.join(dataDir, 'installed.json'),
}

const token = () => randomBytes(8).toString('hex')

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
    if (moved) await retried(() => rename(old, target)).catch(() => {})
    throw err
  }
  await syncDir(path.dirname(target))
  await syncDir(folders.staging(dataDir))
  if (moved) await rm(old, { recursive: true, force: true }).catch(() => {})
}

export async function clear(dir: string): Promise<void> {
  await retried(() => rm(dir, { recursive: true, force: true }))
}

// A host half's start marker. Written and synced before its start, so a host half that freezes main at start is held
// failed at the next boot even after a force quit. Empty: it can only hold a plugin down, so it needs no hash
export async function writeMarker(dataDir: string, id: string): Promise<void> {
  const file = folders.marker(dataDir, id)
  await mkdir(path.dirname(file), { recursive: true })
  const handle = await open(file, 'w')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDir(path.dirname(file))
}

export async function removeMarker(dataDir: string, id: string): Promise<void> {
  const file = folders.marker(dataDir, id)
  await retried(() => rm(file, { force: true }))
  await syncDir(path.dirname(file))
}

const installedFile = z.strictObject({
  format: z.literal(1),
  plugins: z.record(pluginId, z.strictObject({ version: pluginVersion, hash: z.string().regex(/^[0-9a-f]{64}$/) })),
})
export type Installed = Record<string, { version: string, hash: string }>

// The version and hash each install plugin had in the last run, which tells an app update from a start. A file that is
// gone or fails its hash line reads as no run before, so no plugin hears of an update it can't be sure of
export async function readInstalled(dataDir: string): Promise<Installed> {
  let bytes: Buffer
  try {
    bytes = await retried(() => readFile(folders.installed(dataDir)), folders.installed(dataDir), 'read')
  } catch {
    return Object.create(null)
  }
  const checked = checkHash(bytes)
  if (!('body' in checked)) return Object.create(null)
  try {
    return Object.assign(Object.create(null), parseStrict(checked.body, installedFile).plugins)
  } catch {
    return Object.create(null)
  }
}

// Written whole with its hash line, as the state files are. A read-only copy a restore left is cleared first, as the
// StateStore does, or Windows refuses the replace
export async function writeInstalled(dataDir: string, plugins: Installed): Promise<void> {
  const body = Buffer.from(`${JSON.stringify({ format: 1, plugins }, null, 2)}\n`)
  await mkdir(dataDir, { recursive: true })
  await writable(folders.installed(dataDir))
  await replaceFile(folders.installed(dataDir), withHash(body))
}
