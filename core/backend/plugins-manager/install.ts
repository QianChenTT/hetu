import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isReservedId, pluginId } from '../../api/ids.ts'
import { INSTALL_LIST, installList, MAX_INSTALL_LIST_BYTES, type Listed } from '../../api/install.ts'
import { retried } from '../../lib/disk.ts'
import { parseStrict } from '../../lib/hashed-file.ts'
import type { Plugin } from '../boot/header.ts'
import { folders, insideInstall, readInstalled, writeInstalled, type Installed } from './folders.ts'
import { readPlugin, unread, type Read } from './verify.ts'
import { type Known, osFiles, placeOf } from './base.ts'
import { PluginsClasses } from './classes.ts'

// The install and the plugin folder: the install list read and checked and every plugin found read once and verified
// before it runs
export abstract class PluginsInstall extends PluginsClasses {
  // ---- the install

  protected async readInstall(): Promise<void> {
    const file = path.join(this.listDir, INSTALL_LIST)
    let bytes: Buffer | null = null
    try {
      bytes = await retried(() => readFile(file), file, 'read')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.listResult = 'invalid'
    }
    if (bytes !== null) {
      try {
        if (bytes.length > MAX_INSTALL_LIST_BYTES) throw new Error('too large')
        this.install = parseStrict(bytes, installList)
        this.listResult = 'ok'
      } catch {
        this.listResult = 'invalid'
      }
    } else if (this.listResult === 'unread') {
      this.listResult = 'absent'
    }
    this.note('install.checked', { result: this.listResult })
    if (this.install === null) return

    for (const [id, listed] of Object.entries(this.install.plugins)) {
      let root: string | null = null
      try {
        root = insideInstall(this.installDir, listed.path, this.platform)
      } catch {
        // A path the install list can't place inside the install reads as unread, which checked records as missing
      }
      const read = root === null ? unread : await readPlugin(root, id, 'install')
      this.know(id, 'install', root ?? this.installDir, read, listed, null)
      this.checked(id, 'install', read, listed.hash, this.loose(id))
    }

    this.installed = await readInstalled(this.dataDir)
    for (const k of this.known.values()) {
      const last = this.installed[k.id]
      if (last !== undefined && k.listed !== null && (last.version !== k.listed.version || last.hash !== k.listed.hash)) {
        k.updated = last.version
      }
    }
  }

  // The marker for the next run: every core plugin's version and hash, except one whose update hasn't applied yet,
  // which keeps the version it had so the next start finds the change again
  protected async saveInstalled(): Promise<void> {
    if (this.install === null) return
    const next: Installed = Object.create(null)
    for (const k of this.known.values()) {
      if (k.from !== 'install' || k.listed === null) continue
      const last = this.installed[k.id]
      next[k.id] = k.updated !== null && last !== undefined ? last : { version: k.listed.version, hash: k.listed.hash }
    }
    try {
      await writeInstalled(this.dataDir, next)
      this.installed = next
    } catch {
      this.note('fault', { plugin: null, step: 'installed' })
    }
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
    this.know(id, 'folder', root, read, null, entry)
    this.checked(id, 'folder', read, entry?.contentHash ?? null, this.loose(id))
  }

  protected know(id: string, from: 'install' | 'folder', root: string, read: Read, listed: Listed | null, entry: Plugin | null): Known {
    const k: Known = {
      id, from, root, listed, entry, read, place: placeOf(id, read, from), state: 'found', reason: null, held: null,
      live: null, incarnations: 0, lastStop: null, previousVersion: this.versions.get(id) ?? null,
      updated: null,
    }
    this.known.set(id, k)
    return k
  }

  // plugin.checked for every result, ok included. A mismatch the human's switches let through says which switch did
  protected checked(id: string, from: string, read: Read, expected: string | null, loose: boolean): void {
    let result: string
    if (read.hash === null) result = 'missing'
    else if (expected !== null && read.hash !== expected) result = !loose ? 'tampered' : this.dev(id) ? 'dev' : 'skipped'
    else result = read.problem ?? (expected === null ? 'new' : 'ok')
    this.note('plugin.checked', { plugin: id, from, result })
  }
}
