import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { doorId, isReservedId, pluginId } from '../../api/ids.ts'
import { retried } from '../../lib/disk.ts'
import type { Plugin } from '../boot/header.ts'
import { folders } from './folders.ts'
import { doorRead, readPlugin, unread, type Read } from './verify.ts'
import { type Known, osFiles, placeOf } from './base.ts'
import { PluginsClasses } from './classes.ts'

// The door and the plugin folder: the door's code and every plugin found read once and verified before it runs
export abstract class PluginsInstall extends PluginsClasses {
  // ---- the door

  // The door's code as the build wrote it, read once like a plugin's bytes. What it may do is fixed in code, so no
  // manifest is read. Code that can't be read leaves it refused missing
  protected async readDoor(): Promise<void> {
    const file = this.doorFile
    if (file === null) return
    let read = unread
    try {
      read = doorRead(await retried(() => readFile(file), file, 'read'))
    } catch {
      // Read as missing below
    }
    this.know(doorId, 'core', path.dirname(file), read, null)
    this.checked(doorId, 'core', read, null, false)
  }

  // ---- the plugin folder

  // The plugin folder scan: every folder and every entry, each folder's bytes read and hashed once. An id no folder
  // plugin may hold is refused reserved-id unread and kept apart, entry or folder
  protected async scan(): Promise<void> {
    const dir = path.join(this.dataDir, 'plugins')
    const found = new Set<string>()
    let bad = 0
    try {
      for (const dirent of await readdir(dir, { withFileTypes: true })) {
        if (osFiles.has(dirent.name.toLowerCase())) continue
        if (dirent.isDirectory() && pluginId.safeParse(dirent.name).success) found.add(dirent.name)
        else bad++
      }
    } catch {
      // A plugins folder that can't be read gives no folders, so each entry reads as missing and none starts
    }
    if (bad > 0) this.note('plugin.checked', { plugin: null, from: 'folder', result: 'bad-name', count: bad })
    const ids = new Set([...found, ...Object.keys(this.state.plugins)])
    for (const [id, result] of this.entryChecks) if (result !== 'ok' && result !== 'absent') ids.add(id)
    for (const id of [...ids].sort()) await this.scanOne(id, found.has(id))
  }

  protected async scanOne(id: string, present: boolean): Promise<void> {
    if (isReservedId(id)) {
      this.strays.set(id, 'reserved-id')
      this.note('plugin.checked', { plugin: id, from: 'folder', result: 'reserved-id' })
      this.note('plugin.refused', { plugin: id, reason: 'reserved-id' })
      return
    }
    const root = folders.plugins(this.dataDir, id)
    const entry = this.state.plugins[id] ?? null
    const read = present ? await readPlugin(root, id, 'folder') : unread
    this.know(id, 'folder', root, read, entry)
    this.checked(id, 'folder', read, entry?.contentHash ?? null, this.loose(id))
  }

  protected know(id: string, from: 'core' | 'folder', root: string, read: Read, entry: Plugin | null): Known {
    const k: Known = {
      id, from, root, entry, read, place: placeOf(from), state: 'found', reason: null, held: null,
      live: null, incarnations: 0, lastStop: null, previousVersion: this.versions.get(id) ?? null,
    }
    this.known.set(id, k)
    return k
  }

  // plugin.checked for every result, ok included. A mismatch the human's switches let through says which switch did
  protected checked(id: string, from: string, read: Read, expected: string | null, loose: boolean): void {
    let result: string
    if (read.hash === null) result = 'missing'
    else if (expected !== null && read.hash !== expected) result = !loose ? 'tampered' : this.dev(id) ? 'dev' : 'skipped'
    else result = read.problem ?? (expected === null && from === 'folder' ? 'new' : 'ok')
    this.note('plugin.checked', { plugin: id, from, result })
  }
}
