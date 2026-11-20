import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { firstPartyIds, isReservedId, pluginId } from '../../api/ids.ts'
import { FIRST_PARTY_SIGNER, INSTALL_LIST, installList, isNewer, MAX_INSTALL_LIST_BYTES, type Listed } from '../../api/install.ts'
import { retried } from '../../lib/disk.ts'
import { parseStrict } from '../../lib/hashed-file.ts'
import type { Plugin } from '../boot/header.ts'
import { clear, firstPartyPath, folders, readInstalled, stage, swapIn, writeInstalled, type Installed } from './folders.ts'
import { readPlugin, unread, type Read } from './verify.ts'
import { type Known, osFiles, isOne, refused, ok, placeOf } from './base.ts'
import { PluginsClasses } from './classes.ts'

// The install and the plugin folder: the install list read and checked, the first-party copies reconciled with it and
// every plugin found read once and verified before it runs
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
        root = firstPartyPath(this.installDir, listed.path, this.platform)
      } catch {}
      const read = root === null ? unread : await readPlugin(root, id, listed.firstParty ? 'folder' : 'install')
      if (listed.firstParty) {
        this.bundled.set(id, read)
        this.checked(id, 'bundled', read, listed.hash, false)
        continue
      }
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

  // ---- the first-party reconcile

  // Copies a first-party plugin when its entry is absent with no tombstone or when the install's version is newer,
  // through staging, a swap and the entry last. The human's switch survives. A community plugin holding the id is
  // never overwritten or adopted. An entry that failed its check or is in a newer format counts as present and is never
  // written over. In a boot that lost the tombstones nothing is copied that has no entry, a tombstone goes in instead
  protected async reconcile(): Promise<void> {
    const tombstones: string[] = []
    for (const [id, read] of this.bundled) {
      const listed = this.install!.plugins[id]
      // The install's own copy must match its list, or there is nothing trustworthy to copy
      if (read.problem !== null || read.hash !== listed.hash) continue
      const result = this.entryChecks.get(id) ?? 'absent'
      if (result !== 'ok' && result !== 'absent') continue
      const entry = this.state.plugins[id] ?? null
      if (entry === null) {
        if (isOne(this.state.switches.removed, id)) continue
        if (!this.removedKnown) {
          tombstones.push(id)
          continue
        }
        if (await this.foreign(id, listed.hash)) {
          this.note('plugin.collision', { plugin: id })
          continue
        }
        await this.copy(id, read, listed, 'copy', true, null).catch(() => this.note('fault', { plugin: id, step: 'copy' }))
      } else if (entry.signer !== FIRST_PARTY_SIGNER) {
        this.note('plugin.collision', { plugin: id })
      } else if (isNewer(listed.version, entry.version)) {
        await this.copy(id, read, listed, 'copy', entry.enabled, entry.version)
          .catch(() => this.note('fault', { plugin: id, step: 'copy' }))
      }
    }
    if (tombstones.length > 0) await this.tombstone(tombstones)
  }

  // A folder already at plugins/<id> holding other bytes than the install's copy, which the reconcile never overwrites
  protected async foreign(id: string, hash: string): Promise<boolean> {
    const found = await readPlugin(folders.plugins(this.dataDir, id), id, 'folder')
    return found.hash !== null && found.hash !== hash
  }

  // Applies only once its record has landed, so the copy's core record is on disk before the entry widens anything. A
  // restore is asked for on a Confirm, a copy at start has none
  protected async copy(id: string, read: Read, listed: Listed, cause: 'copy' | 'restore', enabled: boolean, previous: string | null, confirm = false): Promise<boolean> {
    const dir = await stage(this.dataDir, id, read.files)
    const landing = await this.landing(id, cause === 'restore' ? 'plugin.restored' : 'plugin.copied', { plugin: id, version: listed.version })
    if (landing === 'lost') {
      await clear(dir).catch(() => {})
      return false
    }
    await swapIn(this.dataDir, id, dir)
    if (previous !== null && previous !== listed.version) await this.clearSpace('cache', id).catch(() => {})
    const change = this.classes(cause, id, this.copied(id, read, listed, enabled, cause), confirm)
    const entry = this.withMarks(id, change.own!.entry!)
    await this.settle(change.others, true)
    await this.store.writePlugin(id, entry)
    this.putEntry(id, entry)
    await this.marksHandedBack(id)
    await this.settle(change.others, false)
    this.raiseOwed(this.touched(change))
    if (previous !== null && previous !== listed.version) this.versions.set(id, previous)
    this.bump()
    return true
  }

  // A narrowing write with no Confirm, so a first-party plugin the human may have removed stays out until plugin.restore
  protected async tombstone(ids: string[]): Promise<void> {
    const removed = [...new Set([...this.state.switches.removed, ...ids])]
    try {
      await this.writeSwitches({ ...this.state.switches, removed })
    } catch {
      this.note('fault', { plugin: null, step: 'tombstone' })
      return
    }
    this.removedKnown = true
    for (const id of ids) this.note('plugin.tombstone', { plugin: id })
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
    } catch {}
    if (bad > 0) this.note('plugin.checked', { plugin: null, from: 'folder', result: 'bad-name', count: bad })
    const ids = new Set([...found, ...Object.keys(this.state.plugins)])
    for (const [id, result] of this.entryChecks) if (result !== 'ok' && result !== 'absent') ids.add(id)
    for (const id of [...ids].sort()) await this.scanOne(id, found.has(id))
  }

  protected async scanOne(id: string, present: boolean): Promise<void> {
    if (isReservedId(id) && !isOne(firstPartyIds, id)) {
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
