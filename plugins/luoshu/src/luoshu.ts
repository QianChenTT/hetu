import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, watch, type FSWatcher } from 'node:fs'
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { LIST_PAGE } from 'hetu-core/api/actions.ts'
import { floorConstants } from 'hetu-core/api/floor.ts'
import type { Call, LuoshuRole, Opening, Prepared, Provider, ProviderRefusal } from 'hetu-core/api/slots.ts'
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

// luoshu.read, luoshu.write and luoshu.list. prepare turns the path the caller wrote into the canonical one with the
// canonicaliser and holds the lock on its key until perform or release, so no other hetu write to that name runs in
// between. perform acts on the path prepare resolved, kept by callId
export function createLuoshu(options: LuoshuOptions = {}): Luoshu {
  const pageSize = options.pageSize ?? LIST_PAGE
  const publish = options.publish ?? (() => {})
  const settleMs = options.settleMs ?? 150
  const readCap = options.readCap ?? floorConstants.resultBytes
  let watcher: FSWatcher | null = null
  const settling = new Map<string, ReturnType<typeof setTimeout>>()
  let opening: (Opening & { folder: string }) | null = null
  // The tail of each key's queue and the release of each call holding one
  const tails = new Map<string, Promise<void>>()
  const holding = new Map<string, () => void>()
  const resolved = new Map<string, Canonical>()
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
    holding.set(callId, () => {
      let_go()
      if (tails.get(key) === tail) tails.delete(key)
    })
  }

  function unlock(callId: string): void {
    resolved.delete(callId)
    preparedUnder.delete(callId)
    const free = holding.get(callId)
    holding.delete(callId)
    free?.()
  }

  async function read(target: Canonical): Promise<unknown> {
    let bytes: Buffer
    try {
      const size = (await stat(target.absolute)).size
      if (size > readCap) throw refused('failed', 'too-large')
      bytes = await retried(() => readFile(target.absolute), target.absolute, 'read')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') throw refused('not-found')
      throw err
    }
    return { text: bytes.toString('utf8'), version: version(bytes) }
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
    await stamped(target.relative, await stampOf(target.absolute).catch(() => null))
    publish('changed', target.relative)
    return { version: made }
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
      const args = (call.args ?? {}) as { path?: unknown, folder?: unknown, baseVersion?: unknown }
      if (call.action === 'luoshu.list') {
        if (args.folder === undefined) return { scope: {} }
        if (typeof args.folder !== 'string') return refused('invalid')
        const target = await canonical(folder, args.folder, { dataDir, installDir })
        if (!target.ok) return refused(target.code)
        resolved.set(call.callId, target)
        return { scope: {} }
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
    open(next: Opening): void {
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
