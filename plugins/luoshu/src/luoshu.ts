import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream, watch, type FSWatcher } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { LIST_PAGE } from 'hetu-core/api/actions.ts'
import { floorConstants } from 'hetu-core/api/floor.ts'
import type { Call, LuoshuOpening, LuoshuRole, Opening, Prepared, Provider, ProviderRefusal } from 'hetu-core/api/slots.ts'
import { canonical, type Canonical } from 'hetu-core/lib/canonical.ts'
import { retried, syncDir } from 'hetu-core/lib/disk.ts'

export type Luoshu = {
  provider: Provider
  role: LuoshuRole
  // Ends the watch, for the plugin's stop
  close(): void
}

export type LuoshuOptions = {
  // Publishes luoshu.<topic> for a path, changed for each write of its own and outside for anything else
  publish?: (topic: 'changed' | 'outside', path: string) => void
  // The most names one listing looks at, LIST_PAGE but in tests
  pageSize?: number
  // How long a path stays quiet before the watcher looks at it, as editors save a file in several writes
  settleMs?: number
  // The largest note a read answers, the floor's resultBytes but in tests. A larger one is refused from its size, before
  // main reads it
  readCap?: number
}

// A write's temp file sits beside the note, a dot file so Obsidian, ** grants and the listing pass it by
const TEMP = '.hetu-tmp'
const isTemp = (name: string) => name.startsWith('.') && name.endsWith(TEMP)
// Opening a note to read it: no link at the last name and no wait on a FIFO, where the system has the flags
const NOTE_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

// What a volume with no hard links answers a link with, so a move falls back to a rename after its check
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL'])
const absent = (err: unknown) => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')

const version = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const refused = (code: ProviderRefusal['code'], reason?: ProviderRefusal['reason']): ProviderRefusal => (reason === undefined ? { code } : { code, reason })
// Windows and macOS compare names without case, so hetu's own folders are found in any spelling there
const fold = process.platform === 'win32' || process.platform === 'darwin' ? (name: string) => name.toLowerCase() : (name: string) => name
const within = (folder: string, target: string) => {
  const [inside, outer] = [fold(target), fold(folder)]
  return inside === outer || inside.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep)
}

// The hash of a file's bytes read a piece at a time, so a large file never sits whole in main
function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file).on('data', piece => hash.update(piece)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
  })
}

// The to end of a move that only changes the spelling of its note's name: the folder the note is in, then the last name
// as the caller wrote it. The one file keeps its one key
function respelled(from: Canonical, input: string): Canonical {
  const name = input.slice(input.lastIndexOf('/') + 1)
  const folder = from.relative.slice(0, from.relative.lastIndexOf('/') + 1)
  return { ...from, absolute: path.join(path.dirname(from.absolute), name), relative: folder + name }
}

// luoshu.read, luoshu.write, luoshu.remove, luoshu.move and luoshu.list. prepare turns each path the caller wrote into
// the canonical one with the canonicaliser and holds the lock on its key until perform or release, so no other hetu
// write to that name runs in between. A move holds the locks of both ends, taken in key order so two moves can't each
// hold the lock the other waits on. perform acts on the paths prepare resolved, kept by callId
export function createLuoshu(options: LuoshuOptions = {}): Luoshu {
  const pageSize = options.pageSize ?? LIST_PAGE
  const publish = options.publish ?? (() => {})
  const settleMs = options.settleMs ?? 150
  const readCap = options.readCap ?? floorConstants.resultBytes
  let watcher: FSWatcher | null = null
  const settling = new Map<string, ReturnType<typeof setTimeout>>()
  let opening: (LuoshuOpening & { folder: string }) | null = null
  // The tail of each key's queue and the releases of each call holding one or two
  const tails = new Map<string, Promise<void>>()
  const holding = new Map<string, (() => void)[]>()
  const resolved = new Map<string, Canonical>()
  // The to end of each move, beside its from end in resolved, and whether both ends are one file
  const moving = new Map<string, { to: Canonical, same: boolean }>()
  // The folder each call was prepared under, so a call prepared before luoshu.set never acts on the folder after it
  const preparedUnder = new Map<string, Opening>()
  // The hash of the bytes hetu itself last wrote to each key, so an event for its own write isn't taken for an outside one
  const own = new Map<string, string>()
  // Each note's size and modified time as last seen, from a walk once the watch began. An event for a note that still
  // matches, or for a path missing then and now, is no news: macOS hands a new watch changes from just before it began
  let stamps: Promise<Map<string, string>> = Promise.resolve(new Map())

  async function lock(key: string, callId: string): Promise<void> {
    const before = tails.get(key) ?? Promise.resolve()
    let let_go!: () => void
    const mine = new Promise<void>(resolve => {
      let_go = resolve
    })
    const tail = before.then(() => mine)
    tails.set(key, tail)
    await before
    const held = holding.get(callId) ?? []
    held.push(() => {
      let_go()
      if (tails.get(key) === tail) tails.delete(key)
    })
    holding.set(callId, held)
  }

  function unlock(callId: string): void {
    resolved.delete(callId)
    moving.delete(callId)
    preparedUnder.delete(callId)
    const held = holding.get(callId) ?? []
    holding.delete(callId)
    for (const free of held) free()
  }

  // The note is opened once and checked and read through that one handle, so what is answered is what was checked: a
  // name swapped for a link to a file outside the notes folder between a check and a read by name would have handed
  // the caller that file. Anything but a regular file is no note
  async function read(target: Canonical): Promise<unknown> {
    let handle
    try {
      handle = await retried(() => open(target.absolute, NOTE_READ), target.absolute, 'read')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') throw refused('not-found')
      if (code === 'ELOOP') throw refused('failed')
      throw err
    }
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw refused('not-found')
      if (info.size > readCap) throw refused('failed', 'too-large')
      const bytes = await handle.readFile()
      // A note that grew after the check is held to the same cap
      if (bytes.length > readCap) throw refused('failed', 'too-large')
      return { text: bytes.toString('utf8'), version: version(bytes) }
    } finally {
      await handle.close()
    }
  }

  async function current(file: string): Promise<string | null> {
    try {
      return await retried(() => hashFile(file), file, 'read')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  // A file's size and modified time to the nanosecond, null for no file
  async function stampOf(file: string): Promise<string | null> {
    try {
      const found = await stat(file, { bigint: true })
      return found.isFile() ? `${found.size}:${found.mtimeNs}` : null
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw err
    }
  }

  async function stamped(relative: string, stamp: string | null): Promise<void> {
    const known = await stamps
    if (stamp === null) known.delete(fold(relative))
    else known.set(fold(relative), stamp)
  }

  // The version is checked under the lock. The bytes go to a temp file beside the note, synced, then a rename over it,
  // so a crash leaves the old note or the new one
  async function write(target: Canonical, text: string, baseVersion: string | undefined): Promise<unknown> {
    if ((await current(target.absolute)) !== (baseVersion ?? null)) throw refused('stale')
    const bytes = Buffer.from(text, 'utf8')
    const dir = path.dirname(target.absolute)
    await mkdir(dir, { recursive: true })
    const temp = path.join(dir, `.${path.basename(target.absolute)}.${randomBytes(6).toString('hex')}${TEMP}`)
    try {
      const handle = await open(temp, 'wx')
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await retried(() => rename(temp, target.absolute), target.absolute)
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {})
      throw err
    }
    await syncDir(dir)
    const made = version(bytes)
    own.set(target.key, made)
    // Not awaited: the walk taken when the watch began can still be running on a large folder, and a save doesn't wait
    // for it. The stamp still lands before any event for this write is judged, which waits on the same walk later
    void stamped(target.relative, await stampOf(target.absolute).catch(() => null))
    publish('changed', target.relative)
    return { version: made }
  }

  // The folder a name sits in, looked at again just before a remove or a move changes the disk. The canonical path was
  // judged at prepare, and a folder on the way swapped for a link or a junction since would carry the change out of
  // what was judged, so one that no longer resolves to itself is refused as canonical refuses a link out
  async function unmoved(absolute: string): Promise<void> {
    const dir = path.dirname(absolute)
    if ((await realpath(dir).catch(() => null)) !== dir) throw refused('not-granted')
  }

  // A regular file at the name itself, never a link put there since prepare and never a folder
  async function isNote(absolute: string): Promise<boolean> {
    try {
      return (await lstat(absolute)).isFile()
    } catch (err) {
      if (absent(err)) return false
      throw err
    }
  }

  // To the bin the runtime hands the luoshu with its folder, so a remove can be undone with hetu closed. A bin that
  // refuses fails the remove and the note stays
  async function remove(target: Canonical, baseVersion: string | undefined, trash: LuoshuOpening['trash']): Promise<null> {
    if (trash === undefined) throw refused('unavailable')
    await unmoved(target.absolute)
    if (!(await isNote(target.absolute))) throw refused('not-found')
    if (baseVersion !== undefined && (await current(target.absolute)) !== baseVersion) throw refused('stale')
    await trash(target.absolute)
    await syncDir(path.dirname(target.absolute))
    own.delete(target.key)
    void stamped(target.relative, null)
    publish('changed', target.relative)
    return null
  }

  // Never onto a name that exists: a hard link at to fails if anything is there, then from is unlinked. One file under a
  // new spelling of its name is a rename in place. A volume with no hard links checks to under both locks and renames,
  // which only a program outside hetu could race
  async function move(from: Canonical, to: Canonical, same: boolean): Promise<null> {
    await unmoved(from.absolute)
    if (!(await isNote(from.absolute))) throw refused('not-found')
    if (same) {
      if (to.absolute !== from.absolute) await retried(() => rename(from.absolute, to.absolute), from.absolute)
    } else {
      await mkdir(path.dirname(to.absolute), { recursive: true })
      await unmoved(to.absolute)
      let linked = true
      try {
        await link(from.absolute, to.absolute)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? ''
        if (code === 'EEXIST') throw refused('stale')
        if (!NO_LINKS.has(code)) throw err
        if ((await lstat(to.absolute).catch(() => null)) !== null) throw refused('stale')
        await retried(() => rename(from.absolute, to.absolute), to.absolute)
        linked = false
      }
      if (linked) {
        try {
          await retried(() => unlink(from.absolute), from.absolute)
        } catch (err) {
          await unlink(to.absolute).catch(() => {})
          throw err
        }
      }
    }
    await syncDir(path.dirname(from.absolute))
    await syncDir(path.dirname(to.absolute))
    own.delete(from.key)
    // In this order, so a rename in place that only changed case ends stamped under its one folded name
    void stamped(from.relative, null)
    void stamped(to.relative, await stampOf(to.absolute).catch(() => null))
    publish('changed', from.relative)
    publish('changed', to.relative)
    return null
  }

  // Every file under start, relative to root, past .git, temp files, links, junctions and hetu's own folders. readdir's
  // entries name a link or junction as a link and never as a folder, so the walk can't follow one even without the check
  async function filesUnder(root: string, start: string, opened: Opening): Promise<string[]> {
    // Resolved as the walk is, so a link or another spelling of a folder still matches
    const skip = await Promise.all([opened.dataDir, opened.installDir].map(folder => realpath(folder).catch(() => folder)))
    const found: string[] = []
    async function walk(dir: string): Promise<void> {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return
        throw err
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isSymbolicLink() || isTemp(entry.name)) continue
        if (entry.isDirectory()) {
          if (entry.name.toLowerCase() === '.git' || skip.some(folder => within(folder, full))) continue
          await walk(full)
        } else if (entry.isFile()) {
          found.push(path.relative(root, full).split(path.sep).join('/'))
        }
      }
    }
    await walk(start)
    return found
  }

  // Every file under start in name order, as filesUnder finds them
  async function list(root: string, start: string, after: string | undefined, canList: (path: string) => boolean): Promise<unknown> {
    const found = await filesUnder(root, start, opening!)
    found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    // Only names the caller may list, so the page and next say nothing of the others. One more than a page tells
    // whether another page follows
    const kept: string[] = []
    for (const name of found) {
      if (after !== undefined && name <= after) continue
      if (!canList(name)) continue
      kept.push(name)
      if (kept.length > pageSize) break
    }
    const paths = kept.slice(0, pageSize)
    return { paths, next: kept.length > pageSize ? paths.at(-1)! : null }
  }

  const provider: Provider = {
    async prepare(call: Call): Promise<Prepared | ProviderRefusal> {
      if (opening === null) return refused('unavailable')
      const { folder, dataDir, installDir } = opening
      preparedUnder.set(call.callId, opening)
      const args = (call.args ?? {}) as { path?: unknown, folder?: unknown, baseVersion?: unknown, from?: unknown, to?: unknown }
      if (call.action === 'luoshu.list') {
        if (args.folder === undefined) return { scope: {} }
        if (typeof args.folder !== 'string') return refused('invalid')
        const target = await canonical(folder, args.folder, { dataDir, installDir })
        if (!target.ok) return refused(target.code)
        resolved.set(call.callId, target)
        return { scope: {} }
      }
      if (call.action === 'luoshu.move') {
        const { from: fromText, to: toText } = args
        if (typeof fromText !== 'string' || typeof toText !== 'string') return refused('invalid')
        const from = await canonical(folder, fromText, { dataDir, installDir })
        if (!from.ok) return refused(from.code)
        const found = await canonical(folder, toText, { dataDir, installDir })
        if (!found.ok) return refused(found.code)
        // Both ends resolve to one file when the move only changes the spelling of its name
        const same = found.absolute === from.absolute
        const to = same ? respelled(from, toText) : found
        for (const key of [...new Set([from.key, to.key])].sort()) await lock(key, call.callId)
        resolved.set(call.callId, from)
        moving.set(call.callId, { to, same })
        return { scope: { paths: [from.relative, to.relative] } }
      }
      if (typeof args.path !== 'string') return refused('invalid')
      const target = await canonical(folder, args.path, { dataDir, installDir })
      if (!target.ok) return refused(target.code)
      await lock(target.key, call.callId)
      resolved.set(call.callId, target)
      const scope = { paths: [target.relative] }
      return typeof args.baseVersion === 'string' ? { scope, baseVersion: args.baseVersion } : { scope }
    },

    async perform(call: Call, prepared: Prepared): Promise<unknown> {
      const target = resolved.get(call.callId)
      const under = preparedUnder.get(call.callId)
      try {
        // A folder picked since prepare, or none now, ends the call: its path belongs to the folder before
        if (opening === null || under !== opening) throw refused('unavailable')
        if (call.action === 'luoshu.list') {
          // The carrier's canList is what keeps a name from a caller that may not list it, so no listing runs without it
          if (call.canList === undefined) throw refused('failed')
          const root = await realpath(opening.folder)
          return await list(root, target?.absolute ?? root, (call.args as { after?: string }).after, call.canList)
        }
        if (target === undefined) throw refused('failed')
        if (call.action === 'luoshu.read') return await read(target)
        if (call.action === 'luoshu.write') return await write(target, (call.args as { text: string }).text, prepared.baseVersion)
        if (call.action === 'luoshu.remove') return await remove(target, prepared.baseVersion, opening.trash)
        const moved = moving.get(call.callId)
        if (call.action === 'luoshu.move' && moved !== undefined) return await move(target, moved.to, moved.same)
        throw refused('invalid')
      } finally {
        unlock(call.callId)
      }
    },

    release(call: Call): void {
      unlock(call.callId)
    },
  }

  // A path the OS says changed, once it has been quiet for settleMs: hetu's own write when its bytes hash as the last
  // write hetu made there, an outside one otherwise, a delete included. A folder throws in current and is no note
  async function settled(relative: string): Promise<void> {
    const now = opening
    if (now === null) return
    const target = await canonical(now.folder, relative, { dataDir: now.dataDir, installDir: now.installDir })
    if (!target.ok || opening !== now) return
    let made: string | null
    let stamp: string | null
    try {
      made = await current(target.absolute)
      stamp = await stampOf(target.absolute)
    } catch {
      return
    }
    const known = await stamps
    if (opening !== now) return
    const before = known.get(fold(target.relative)) ?? null
    await stamped(target.relative, stamp)
    if (made !== null && own.get(target.key) === made) return
    if (before === stamp) return
    // The note no longer holds hetu's last write, so a later save of those same bytes is someone else's too
    own.delete(target.key)
    publish('outside', target.relative)
  }

  function heard(folder: string, name: string | null): void {
    if (name === null) return
    const parts = name.split(/[\\/]/)
    if (parts.some(part => part.toLowerCase() === '.git') || isTemp(parts.at(-1)!)) return
    const full = path.join(folder, name)
    if (opening === null || [opening.dataDir, opening.installDir].some(own => within(own, full))) return
    const relative = parts.join('/')
    clearTimeout(settling.get(relative))
    const timer = setTimeout(() => {
      settling.delete(relative)
      void settled(relative).catch(() => {})
    }, settleMs)
    timer.unref?.()
    settling.set(relative, timer)
  }

  function stopWatching(): void {
    watcher?.close()
    watcher = null
    for (const timer of settling.values()) clearTimeout(timer)
    settling.clear()
  }

  const role: LuoshuRole = {
    open(next: LuoshuOpening): void {
      stopWatching()
      opening = next.folder === null ? null : { ...next, folder: next.folder }
      own.clear()
      stamps = Promise.resolve(new Map())
      if (opening === null) return
      const { folder } = opening
      try {
        // Recursive on Windows, macOS and Linux since Node 20. A folder that can't be watched leaves reads and writes
        // working, with no outside events
        watcher = watch(folder, { recursive: true }, (_event, name) => heard(folder, typeof name === 'string' ? name : null))
        watcher.on('error', () => stopWatching())
      } catch {
        watcher = null
      }
      // Taken once the watch began, so a change in between is heard. Events wait for it before they settle
      const now = opening
      stamps = (async () => {
        const known = new Map<string, string>()
        for (const relative of await filesUnder(folder, folder, now)) {
          const stamp = await stampOf(path.join(folder, relative)).catch(() => null)
          if (stamp !== null) known.set(fold(relative), stamp)
        }
        return known
      })().catch(() => new Map<string, string>())
    },
  }

  return { provider, role, close: stopWatching }
}
