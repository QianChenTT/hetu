import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream, watch, type BigIntStats, type FSWatcher } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { LIST_PAGE } from '../../../api/actions.ts'
import { defaultLimits } from '../../../api/limits.ts'
import { isDotName } from '../../../api/scope.ts'
import type { Call, LuoshuOpening, LuoshuRole, Opening, Prepared, Provider, ProviderRefusal } from '../../../api/policy-jobs.ts'
import { canonical, folderState, listedState, looked, named, type Canonical, type FolderState, type NotCanonical, type Opened } from '../../../lib/canonical.ts'
import { retried, syncDir } from '../../../lib/disk.ts'

// Whether the gate allows a call to act on the path a look resolved again, which differs from the one it judged
type Judged = (now: Canonical) => boolean
// The same for every path of a call at once, in the order prepare gave them
type Ask = (paths: string[]) => boolean

export type Luoshu = {
  provider: Provider
  role: LuoshuRole
  // Ends the watch, for the plugin's stop
  close(): void
  // How many calls luoshu keeps anything for, 0 once each has ended, a call refused at prepare included
  calls(): number
}

export type LuoshuOptions = {
  // Publishes luoshu.<topic> for a path, changed for each write of its own and outside for anything else
  publish?: (topic: 'changed' | 'outside', path: string) => void
  // The most names one listing looks at, LIST_PAGE but in tests
  pageSize?: number
  // How long a path stays quiet before the watcher looks at it, as editors save a file in several writes
  settleMs?: number
  // The largest note a read answers, the fixed resultBytes but in tests. A larger one is refused from its size, before
  // main reads it
  readCap?: number
}

// A write's temp file sits beside the note, a dot file so Obsidian, ** grants and the listing pass it by
const TEMP = '.hetu-tmp'
const isTemp = (name: string) => name.startsWith('.') && name.endsWith(TEMP)
// A temp file as a write names it, which a crash can leave: the note's name, then six random bytes
const LEFT = /^\..+\.[0-9a-f]{12}\.hetu-tmp$/
// How old a temp file has to be before the walk at open takes it for one a crash left and removes it
const LEFT_MS = 60_000
// Opening a note to read it: no link at the last name and no wait on a FIFO, where the system has the flags
const NOTE_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
// How many times a note is opened when its name holds another file each time it is looked at again
const OPENS = 3

// What a volume with no hard links answers a link with, so a move falls back to a rename after its check
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL'])
const absent = (err: unknown) => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')

const version = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const refused = (code: ProviderRefusal['code'], reason?: ProviderRefusal['reason']): ProviderRefusal => (reason === undefined ? { code } : { code, reason })
// What a call refused not-granted throws once the call's judge refused the path it would act on: the judge's own
// refusal, so the caller and the record get the gate's code or a guard's and not a missing grant whatever refused
const passedOn = (err: unknown, denied: ProviderRefusal | null): unknown =>
  denied !== null && typeof err === 'object' && err !== null && !(err instanceof Error) && (err as ProviderRefusal).code === 'not-granted' ? denied : err
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
// the canonical one with the canonicaliser and holds the latch on its key until perform or release, so no other hetu
// write to that name runs in between. A move holds the latches of both ends, taken in key order so two moves can't each
// hold the latch the other waits on. perform acts on the paths prepare resolved, kept by callId
export function createLuoshu(options: LuoshuOptions = {}): Luoshu {
  const pageSize = options.pageSize ?? LIST_PAGE
  const publish = options.publish ?? (() => {})
  const settleMs = options.settleMs ?? 150
  const readCap = options.readCap ?? defaultLimits.resultBytes
  let watcher: FSWatcher | null = null
  const settling = new Map<string, ReturnType<typeof setTimeout>>()
  let opening: (LuoshuOpening & { folder: string }) | null = null
  // The tail of each key's latch queue and the releases of each call holding one latch or two
  const tails = new Map<string, Promise<void>>()
  const holding = new Map<string, (() => void)[]>()
  const resolved = new Map<string, Canonical>()
  // The to end of each move, beside its from end in resolved, and whether both ends are one file
  const moving = new Map<string, { to: Canonical, same: boolean }>()
  // The folder each call was prepared under, so a call prepared before luoshu.pick never acts on the folder after it
  const preparedUnder = new Map<string, Opening>()
  // The paths that stand for a name spelled with no dot that leads to a dot name, which no write lands on
  const nowhere = new WeakSet<Canonical>()
  // The path each target was prepared from, as the caller wrote it, so a look at its folder can resolve it again
  const spelling = new WeakMap<Canonical, string>()
  // The hash of the bytes hetu itself last wrote to each key, so an event for its own write isn't taken for an outside one
  const own = new Map<string, string>()
  // Each note's size and modified time as last seen, from a walk once the watch began. An event for a note that still
  // matches, or for a path missing then and now, is no news: macOS hands a new watch changes from just before it began
  let stamps: Promise<Map<string, string>> = Promise.resolve(new Map())

  async function latch(key: string, callId: string): Promise<void> {
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

  function unlatch(callId: string): void {
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
  async function read(prepared: Canonical, judged: Judged): Promise<unknown> {
    // The folder looked at again just before the open, as before a write. One gone since holds no note and the open
    // answers so
    const { state, target } = await lookAt(prepared, folderState, judged)
    if (state === 'moved') throw refused('not-granted')
    const note = await openedNote(prepared, target, judged)
    if (note === null) throw refused('not-found')
    const { handle, info } = note
    try {
      if (!info.isFile()) throw refused('not-found')
      if (info.size > BigInt(readCap)) throw refused('failed', 'too-large')
      const bytes = await handle.readFile()
      // A note that grew after the check is held to the same cap
      if (bytes.length > readCap) throw refused('failed', 'too-large')
      return { text: bytes.toString('utf8'), version: version(bytes), path: note.target.relative }
    } finally {
      await handle.close()
    }
  }

  // The note at a path to act on, opened for reading and looked at again once open: the open follows whatever name the
  // disk gives the caller's spelling, a note made under another case of the last name since prepare included, which no
  // look at the folder sees. So the spelling is resolved again and has to hold the file opened at the path judged or
  // one judged says the gate allows (named), else the call is refused not-granted. A name that holds another file by
  // then is opened again, a few times before the call answers stale. null for no note at the name. The caller closes
  // the handle
  async function openedNote(prepared: Canonical, target: Canonical, judged: Judged): Promise<{ handle: FileHandle, info: BigIntStats, target: Canonical } | null> {
    for (let tries = 1; ; tries++) {
      let handle: FileHandle
      try {
        handle = await retried(() => open(target.absolute, NOTE_READ), target.absolute, 'read')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null
        if (code === 'ELOOP') throw refused('failed')
        throw err
      }
      let found: Canonical | null
      let info: BigIntStats
      try {
        info = await handle.stat({ bigint: true })
        found = await namedAgain(prepared, target, info, judged)
      } catch (err) {
        await handle.close()
        throw err
      }
      if (found !== null) return { handle, info, target: found }
      await handle.close()
      if (tries >= OPENS) throw refused('stale')
    }
  }

  // The caller's spelling resolved again for a file opened or about to be acted on, as named gives it: the path to go
  // on with, null for a name that holds another file by now, a refusal not-granted for a path the gate did not allow
  // or another key. A path that stands for a name leading to a dot name has no file and is never resolved again
  async function namedAgain(prepared: Canonical, target: Canonical, opened: Opened, judged: Judged): Promise<Canonical | null> {
    const spelled = spelling.get(prepared)
    const now = opening
    if (now === null || spelled === undefined || nowhere.has(prepared)) return target
    const found = await named(target, opened, () => canonical(now.folder, spelled, { dataDir: now.dataDir, installDir: now.installDir }), judged)
    if (found.state === 'held') {
      spelling.set(found.target, spelled)
      return found.target
    }
    if (found.state === 'moved') throw refused('not-granted')
    return null
  }

  // The hash of a note's bytes read through its open handle a piece at a time, so a large note never sits whole in main
  async function hashOpen(handle: FileHandle): Promise<string> {
    const hash = createHash('sha256')
    const piece = Buffer.alloc(64 * 1024)
    for (let at = 0; ;) {
      const { bytesRead } = await handle.read(piece, 0, piece.length, at)
      if (bytesRead === 0) return hash.digest('hex')
      hash.update(piece.subarray(0, bytesRead))
      at += bytesRead
    }
  }

  // The version of the note a write or a remove acts on, checked under the latch: the note opened as a read opens it,
  // null for none, with the path to act on and the file opened, which the name has to hold still right before the act.
  // A folder at the name throws as reading one does
  async function versionAt(prepared: Canonical, target: Canonical, judged: Judged): Promise<{ version: string | null, target: Canonical, file: Opened | null }> {
    const note = await openedNote(prepared, target, judged)
    if (note === null) return { version: null, target, file: null }
    try {
      if (!note.info.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' })
      return { version: await hashOpen(note.handle), target: note.target, file: note.info }
    } finally {
      await note.handle.close()
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

  // The version is checked under the latch. The bytes go to a temp file beside the note, synced, then a rename over it,
  // so a crash leaves the old note or the new one. A new note lands by a link in place of the rename (landNew)
  async function write(prepared: Canonical, text: string, baseVersion: string | undefined, judged: Judged): Promise<unknown> {
    // The version check reads the note, so the folder is looked at before it as before a read, then again once the
    // folders the note needs exist
    const first = await lookAt(prepared, folderState, judged)
    if (first.state === 'moved') throw refused('not-granted')
    // Through the note opened, so a note made under another case of the last name since prepare is judged before its
    // version is compared. The rename over a note there still acts on the name after this check
    const checked = await versionAt(prepared, first.target, judged)
    if (checked.version !== (baseVersion ?? null)) throw refused('stale')
    if (nowhere.has(prepared)) throw refused('not-granted')
    const bytes = Buffer.from(text, 'utf8')
    let target = await unmoved(await madeUnder(checked.target, judged), judged)
    const dir = path.dirname(target.absolute)
    const temp = path.join(dir, `.${path.basename(target.absolute)}.${randomBytes(6).toString('hex')}${TEMP}`)
    try {
      const handle = await open(temp, 'wx')
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      // Once more with the temp file written, so a folder swapped since the look before the temp file was made carries
      // no note where it leads. The note lands on the path this look gives. The temp file is removed by the same path
      target = await unmoved(target, judged)
      if (checked.file === null) await landNew(temp, target.absolute)
      else {
        // The note the version was checked on, still at the name by file id, so a note another program swapped in since
        // is never replaced. What is left is the time between this look and the rename
        if (!(await holds(target.absolute, checked.file))) throw refused('stale')
        await retried(() => rename(temp, target.absolute), target.absolute)
      }
    } catch (err) {
      // A temp file left here is removed by the walk at open once it is old, the write's own error goes up
      await rm(temp, { force: true }).catch(() => {})
      throw err
    }
    await syncDir(path.dirname(target.absolute))
    const made = version(bytes)
    own.set(target.key, made)
    // Not awaited: the walk taken when the watch began can still be running on a large folder, and a save doesn't wait
    // for it. The stamp still lands before any event for this write is judged, which waits on the same walk later
    void stamped(target.relative, await stampOf(target.absolute).catch(() => null))
    publish('changed', target.relative)
    return { version: made }
  }

  // A note the version check found missing lands by a hard link from the temp file, which fails when anything answers
  // to the name by then: a note made since under another case or under a name whose 8.3 short name this is, as a write
  // under another key or another program can make one, or a folder. A rename would replace it. Such a write answers
  // stale, as one over a name taken at the version check does. A note landed by a link gets no 8.3 short name on NTFS
  async function landNew(temp: string, target: string): Promise<void> {
    try {
      await link(temp, target)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw refused('stale')
      if (absent(err)) throw err
      // A volume with no hard links, or a link refused for another reason: the name is claimed by a create that fails
      // the same way when anything answers to it, then the temp file is renamed over the claim
      await claimed(target, () => retried(() => rename(temp, target), target))
      return
    }
    // The note has landed. A temp file that can't be removed is a second name of it, which the walk at open removes
    await retried(() => unlink(temp), temp).catch(() => {})
  }

  // The name claimed by an exclusive create, which fails when anything answers to it, then act run over the claim. A
  // claim act leaves behind is taken back while the name still holds it. Between the claim and the act only another
  // program can change the name, since hetu's writes to one key wait on each other and no other key reaches a claim
  async function claimed(target: string, act: () => Promise<void>): Promise<void> {
    let claim: FileHandle
    try {
      claim = await open(target, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw refused('stale')
      throw err
    }
    let mine: Opened
    try {
      mine = await claim.stat({ bigint: true })
    } finally {
      await claim.close()
    }
    try {
      await act()
    } catch (err) {
      // A claim that can't be taken back stays as an empty file at the note's name, the act's error still goes up
      if (await holds(target, mine)) await retried(() => unlink(target), target).catch(() => {})
      throw err
    }
  }

  // Whether the name holds the file given, by file id
  async function holds(absolute: string, file: Opened): Promise<boolean> {
    const there = await lstat(absolute, { bigint: true }).catch(() => null)
    return there !== null && there.ino === file.ino && there.dev === file.dev
  }

  // The folder a name sits in, looked at again just before a write, a remove or a move changes the disk. One that no
  // longer resolves to itself, or is gone, is refused. Answers the path to act on
  async function unmoved(prepared: Canonical, judged: Judged): Promise<Canonical> {
    const { state, target } = await lookAt(prepared, folderState, judged)
    if (state !== 'held') throw refused('not-granted')
    return target
  }

  // The folder of a prepared path looked at again. One that reads as moved gets one more look through canonical on the
  // caller's spelling, whose path goes on when it is the one judged or judged says the gate allows it. A path that
  // stands for a name leading to a dot name is never resolved again
  async function lookAt(prepared: Canonical, look: (absolute: string) => Promise<FolderState>, judged: Judged): Promise<{ state: FolderState, target: Canonical }> {
    const spelled = spelling.get(prepared)
    const now = opening
    if (now === null || spelled === undefined || nowhere.has(prepared)) return { state: await look(prepared.absolute), target: prepared }
    const found = await looked(prepared, look, () => canonical(now.folder, spelled, { dataDir: now.dataDir, installDir: now.installDir }), judged)
    spelling.set(found.target, spelled)
    return found
  }

  // Anything at the name, a link included, which lstat never follows
  async function present(absolute: string): Promise<boolean> {
    try {
      await lstat(absolute)
      return true
    } catch (err) {
      if (absent(err)) return false
      throw err
    }
  }

  // The folders a write or a move's to end needs, made only below the deepest one that exists once that one still
  // resolves to itself, so a folder swapped for a link or a junction since prepare gets no new folder made through it.
  // One that doesn't gets the one more look the folder's look gives: the caller's spelling resolved again, which goes on
  // when it gives the key prepare took. Then one level at a time, each looked at once made. One that doesn't resolve to
  // itself, made through a folder swapped since the look before or first under another spelling, ends the making there,
  // so a swap that races the call puts at most one empty folder where it leads. The look at the note's folder after this
  // decides whether the call goes on. Answers the path to act on
  async function madeUnder(prepared: Canonical, judged: Judged): Promise<Canonical> {
    let target = prepared
    for (let again = true; ; again = false) {
      const missing: string[] = []
      let existing = path.dirname(target.absolute)
      while (!(await present(existing)) && path.dirname(existing) !== existing) {
        missing.unshift(existing)
        existing = path.dirname(existing)
      }
      if ((await realpath(existing).catch(() => null)) === existing) {
        for (const dir of missing) {
          await mkdir(dir).catch(err => {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
          })
          if ((await realpath(dir).catch(() => null)) !== dir) break
        }
        return target
      }
      const now = again ? await resolvedAgain(prepared, judged) : null
      if (now === null) throw refused('not-granted')
      target = now
    }
  }

  // canonical once more on the spelling the caller wrote, when it gives the key prepare took and the path judged or one
  // judged says the gate allows. Never for a path that stands for a name leading to a dot name
  async function resolvedAgain(prepared: Canonical, judged: Judged): Promise<Canonical | null> {
    const spelled = spelling.get(prepared)
    const now = opening
    if (now === null || spelled === undefined || nowhere.has(prepared)) return null
    const found = await canonical(now.folder, spelled, { dataDir: now.dataDir, installDir: now.installDir })
    if (!found.ok || found.key !== prepared.key) return null
    if (found.relative !== prepared.relative && !judged(found)) return null
    spelling.set(found, spelled)
    return found
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
  // refuses fails the remove and the note stays. Only at the version the remover read, as a write over a note, so no
  // version answers stale
  async function remove(prepared: Canonical, baseVersion: string | undefined, trash: LuoshuOpening['trash'], judged: Judged): Promise<null> {
    if (trash === undefined) throw refused('unavailable')
    const looked = await unmoved(prepared, judged)
    if (!(await isNote(looked.absolute))) throw refused('not-found')
    // Through the note opened, so a note made under another case of the last name since prepare is judged before its
    // version is compared. The bin still takes the note by name after it, once the name holds the file checked still,
    // so what is left is the time between that look and the bin's own move
    const { version: found, target, file } = await versionAt(prepared, looked, judged)
    if (found !== baseVersion || file === null) throw refused('stale')
    if (!(await holds(target.absolute, file))) throw refused('stale')
    await trash(target.absolute)
    await syncDir(path.dirname(target.absolute))
    own.delete(target.key)
    void stamped(target.relative, null)
    publish('changed', target.relative)
    return null
  }

  // Never onto a name that exists: a hard link at to fails if anything is there, then from is unlinked. One file under a
  // new spelling of its name is a rename in place. A volume with no hard links checks to under both latches and renames,
  // which only a program outside hetu could race
  async function move(source: Canonical, destination: Canonical, same: boolean, ask: Ask): Promise<null> {
    const ends = [source.relative, destination.relative]
    const end = (at: 0 | 1): Judged => now => {
      const paths = at === 0 ? [now.relative, ends[1]] : [ends[0], now.relative]
      if (!ask(paths)) return false
      ends[at] = now.relative
      return true
    }
    const looked = await unmoved(source, end(0))
    const there = await lstat(looked.absolute, { bigint: true }).catch(err => {
      if (absent(err)) return null
      throw err
    })
    if (there === null || !there.isFile()) throw refused('not-found')
    // The from end resolved again from the caller's spelling, so a note made under another case of the last name since
    // prepare is judged before it is linked or renamed. One that holds another file by now has changed under the call
    const fromNow = await namedAgain(source, looked, there, end(0))
    if (fromNow === null) throw refused('stale')
    let from = fromNow
    if (nowhere.has(destination)) throw refused('not-granted')
    let to = destination
    if (same) {
      // The from end as it was looked at, with the last name as the caller wrote it
      to = respelled(from, spelling.get(destination) ?? destination.relative)
      if (to.relative !== ends[1] && !end(1)(to)) throw refused('not-granted')
      if (to.absolute !== from.absolute) {
        // The file looked at, at the name still, as before a write's rename
        if (!(await holds(from.absolute, there))) throw refused('stale')
        await retried(() => rename(from.absolute, to.absolute), from.absolute)
      }
    } else {
      to = await madeUnder(to, end(1))
      to = await unmoved(to, end(1))
      let linked = true
      try {
        await link(from.absolute, to.absolute)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? ''
        if (code === 'EEXIST') throw refused('stale')
        if (!NO_LINKS.has(code)) throw err
        // The to end claimed as a new note's name is, so the rename lands on nothing another write made there since
        await claimed(to.absolute, () => retried(() => rename(from.absolute, to.absolute), to.absolute))
        linked = false
      }
      if (linked) {
        // The file at the to end once linked. None there already leaves nothing to take back and the from end as it was
        const made = await lstat(to.absolute, { bigint: true }).catch(() => null)
        if (made === null) throw refused('stale')
        try {
          // The file linked is the one the from end holds as judged, else the link is taken back: another program can
          // put a note under another case of the last name between the look and the link
          const still = await namedAgain(source, from, made, end(0))
          if (still === null) throw refused('stale')
          from = still
          await retried(() => unlink(still.absolute), still.absolute)
        } catch (err) {
          await takenBack(to.absolute, from.absolute, there)
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

  // A move's link at the to end taken back once the move is refused, only while the to end holds a file the link can
  // have made: the one the from end was looked at as or the one at the from end now, which the link gave a second
  // name. So another program's note made at the to end since is left. A link that can't be taken back throws what the
  // router answers failed with a fault and records, so the caller isn't told the move was refused while its note sits
  // at the to end too
  async function takenBack(to: string, from: string, looked: Opened): Promise<void> {
    const there = await lstat(to, { bigint: true }).catch(() => null)
    if (there === null) return
    const atFrom = await lstat(from, { bigint: true }).catch(() => null)
    if (![looked, atFrom].some(file => file !== null && file.ino === there.ino && file.dev === there.dev)) return
    try {
      await retried(() => unlink(to), to)
    } catch (err) {
      throw new Error(`a move's link at the to end could not be taken back: ${(err as NodeJS.ErrnoException).code ?? err}`)
    }
  }

  // Every file under start, relative to root, past dot files and dot folders at any depth (.git and the temp files a
  // write makes among them), links, junctions and hetu's own folders. The dot check is the walk's own, since canList
  // lets every name through with the gate off by the human. readdir's entries name a link or junction as a link and
  // never as a folder, so the walk can't follow one even without the check. The temp files a write names that the walk
  // passes by go into left when it is given
  async function filesUnder(root: string, start: string, opened: Opening, left?: string[]): Promise<string[]> {
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
        if (entry.isSymbolicLink()) continue
        if (isDotName(entry.name)) {
          if (entry.isFile() && LEFT.test(entry.name)) left?.push(full)
          continue
        }
        if (entry.isDirectory()) {
          if (skip.some(folder => within(folder, full))) continue
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

  // What a call acts on. For a name spelled with no dot that leads to a dot name, canonical's same name as if nothing
  // were there: a read, a listing, a remove and the from end of a move meet a missing name. A write or the to end of a
  // move is refused at perform as the dot name is, after the gate judged the name a missing one gives it. So the
  // answer tells a caller with no grant no more than a missing name's and one with a grant learns it from a write. The
  // time a call takes is not evened out
  function usable(found: Canonical | NotCanonical): Canonical | ProviderRefusal {
    if (found.ok) return found
    if (found.code !== 'not-granted' || found.absent === undefined) return refused(found.code)
    nowhere.add(found.absent)
    return found.absent
  }

  const provider: Provider = {
    async prepare(call: Call): Promise<Prepared | ProviderRefusal> {
      if (opening === null) return refused('unavailable')
      const under = opening
      const { folder, dataDir, installDir } = under
      // The folder is kept only for a call prepare takes, since the router releases no other
      const took = (given: Prepared): Prepared => (preparedUnder.set(call.callId, under), given)
      const args = (call.args ?? {}) as { path?: unknown, folder?: unknown, baseVersion?: unknown, from?: unknown, to?: unknown }
      if (call.action === 'luoshu.list') {
        if (args.folder === undefined) return took({ scope: {} })
        if (typeof args.folder !== 'string') return refused('invalid')
        const target = usable(await canonical(folder, args.folder, { dataDir, installDir }))
        if (!('ok' in target)) return target
        spelling.set(target, args.folder)
        resolved.set(call.callId, target)
        return took({ scope: {} })
      }
      if (call.action === 'luoshu.move') {
        const { from: fromText, to: toText } = args
        if (typeof fromText !== 'string' || typeof toText !== 'string') return refused('invalid')
        const from = usable(await canonical(folder, fromText, { dataDir, installDir }))
        if (!('ok' in from)) return from
        const found = usable(await canonical(folder, toText, { dataDir, installDir }))
        if (!('ok' in found)) return found
        // Both ends resolve to one file when the move only changes the spelling of its name
        const same = found.absolute === from.absolute
        const to = same ? respelled(from, toText) : found
        spelling.set(from, fromText)
        spelling.set(to, toText)
        for (const key of [...new Set([from.key, to.key])].sort()) await latch(key, call.callId)
        resolved.set(call.callId, from)
        moving.set(call.callId, { to, same })
        return took({ scope: { paths: [from.relative, to.relative] } })
      }
      if (typeof args.path !== 'string') return refused('invalid')
      const target = usable(await canonical(folder, args.path, { dataDir, installDir }))
      if (!('ok' in target)) return target
      spelling.set(target, args.path)
      await latch(target.key, call.callId)
      resolved.set(call.callId, target)
      const scope = { paths: [target.relative] }
      return took(typeof args.baseVersion === 'string' ? { scope, baseVersion: args.baseVersion } : { scope })
    },

    async perform(call: Call, prepared: Prepared): Promise<unknown> {
      const target = resolved.get(call.callId)
      const under = preparedUnder.get(call.callId)
      try {
        // A folder picked since prepare, or none now, ends the call: its path belongs to the folder before
        if (opening === null || under !== opening) throw refused('unavailable')
        if (call.action === 'luoshu.list') {
          // The router's canList is what keeps a name from a caller that may not list it, so no listing runs without it
          if (call.canList === undefined) throw refused('failed')
          // The folder listed looked at again before the walk, as before a read. One gone since lists nothing
          // Every name a listing gives is judged by canList on its own path, so its folder needs no judging again
          const listed = target === undefined ? undefined : await lookAt(target, listedState, () => true)
          if (listed?.state === 'moved') throw refused('not-granted')
          const root = await realpath(opening.folder)
          const page = await list(root, listed?.target.absolute ?? root, (call.args as { after?: string }).after, call.canList)
          // Once more after the walk, so a folder swapped for a junction while it was walked lists nothing
          if (listed !== undefined && (await lookAt(listed.target, listedState, () => true)).state === 'moved') throw refused('not-granted')
          return page
        }
        if (target === undefined) throw refused('failed')
        // The gate asked again on the paths the call would act on now. With no judge on the call the answer is no. The
        // judge's own refusal is kept, so a call refused for it answers what refused: the gate, a guard or a gate that
        // is down
        let denied: ProviderRefusal | null = null
        const ask: Ask = paths => {
          if (call.judge === undefined) return false
          const answer = call.judge(paths)
          denied = answer === null ? null : refused(answer.code, answer.reason)
          return answer === null
        }
        const one: Judged = now => ask([now.relative])
        try {
          if (call.action === 'luoshu.read') return await read(target, one)
          if (call.action === 'luoshu.write') return await write(target, (call.args as { text: string }).text, prepared.baseVersion, one)
          if (call.action === 'luoshu.remove') return await remove(target, prepared.baseVersion, opening.trash, one)
          const moved = moving.get(call.callId)
          if (call.action === 'luoshu.move' && moved !== undefined) return await move(target, moved.to, moved.same, ask)
          throw refused('invalid')
        } catch (err) {
          throw passedOn(err, denied)
        }
      } finally {
        unlatch(call.callId)
      }
    },

    release(call: Call): void {
      unlatch(call.callId)
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
      // A look that throws publishes nothing, as settled itself does for a note it can't read
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
      const left: string[] = []
      stamps = (async () => {
        const known = new Map<string, string>()
        for (const relative of await filesUnder(folder, folder, now, left)) {
          const stamp = await stampOf(path.join(folder, relative)).catch(() => null)
          if (stamp !== null) known.set(fold(relative), stamp)
        }
        return known
      })().catch(() => new Map<string, string>())
      void stamps.then(() => removeLeft(left, now))
    },
  }

  // The temp files a crash left: before the rename or the link of a write, or after its link as a second name of the
  // note, which would keep the bytes of a note removed or written over since in the notes folder. Only one older than
  // LEFT_MS, so the temp file of a write still running is kept, and only while the folder is still the one walked
  async function removeLeft(left: readonly string[], walked: NonNullable<typeof opening>): Promise<void> {
    for (const file of left) {
      if (opening !== walked) return
      const found = await lstat(file).catch(() => null)
      // A left temp file that can't go now is tried again at the next open
      if (found?.isFile() && Date.now() - found.mtimeMs > LEFT_MS) await unlink(file).catch(() => {})
    }
  }

  const calls = () => new Set([...preparedUnder.keys(), ...resolved.keys(), ...moving.keys(), ...holding.keys()]).size
  return { provider, role, close: stopWatching, calls }
}
