import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { fromBufferPromise, type Entry, type ZipFile } from 'yauzl'
import { withoutIgnorable } from '../../api/names.ts'
import { clear } from './folders.ts'

// The most one plugin zip or picked folder may stage: entries, every folder a name implies among them, and bytes as
// written to disk
export type UnpackLimits = { entries: number, bytes: number }
export const unpackLimits: UnpackLimits = Object.freeze({ entries: 2000, bytes: 64 * 1024 * 1024 })

// What one name may hold. NTFS and most volumes take 255 UTF-16 units a segment. The depth and the length keep every
// path one that Windows tools can still delete
const NAME_CAP = 1024
const SEGMENT_CAP = 255
const DEPTH_CAP = 32

// Why a zip or a picked folder was refused. invalid: no zip the reader takes, a name the reader refuses, data that won't
// inflate or a size it declares that its data doesn't have. special: a link, a device, a pipe or a socket, or a type
// that disagrees with the name. not-a-folder: a picked folder that is missing, a file or a link
export type UnpackProblem = 'invalid' | 'name' | 'duplicate' | 'special' | 'encrypted' | 'too-many' | 'too-big' | 'not-a-folder'

// What staging answers: the refusal or null, and whether anything may be left in the staging folder after a refusal,
// when emptying it failed
export type Staged = { problem: UnpackProblem | null, leftovers: boolean }

class Refused extends Error {
  readonly problem: UnpackProblem

  constructor(problem: UnpackProblem) {
    super(problem)
    this.problem = problem
  }
}

// The reader checks names and sizes itself. strictFileNames off has it turn each \ into / before its own name check,
// so a zip from Windows PowerShell 5.1's Compress-Archive, which writes \ between segments, unpacks, while ..\x, \x
// and C:\x are still refused as climbing, absolute or a drive. The checks here run again on every name it hands over
const READER = { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: false } as const

// Bit 0 of the flags. The reader refuses bit 6, the strong encryption, itself
const ENCRYPTED = 0x1
// The file type in a Unix mode, the high half of the external attributes
const TYPE = 0o170000
const FILE = 0o100000
const FOLDER = 0o040000
// The MS-DOS attribute Windows sets on a link or a junction
const REPARSE_POINT = 0x400

// Another system's separator, a drive or stream colon, a control character and the characters Windows refuses in a name
const notInName = /[\\:<>"|?*\p{Cc}]/u
// What Windows opens as a device in any folder, with or without an extension
const device = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\..*)?$/i

// Why an entry's name, a folder's without its last /, can't be written under the staging folder, or null. An absolute
// name starts with an empty segment and a drive holds a colon. Windows drops a trailing dot or space, so such a name
// would land as another
export function nameProblem(name: string): string | null {
  if (name === '') return 'empty'
  if (name.length > NAME_CAP) return 'longer than 1,024 characters'
  const segments = name.split('/')
  if (segments.length > DEPTH_CAP) return 'deeper than 32 segments'
  if (notInName.test(name)) return 'a character no plugin file name holds'
  if (withoutIgnorable(name) !== name) return 'a character some volumes skip when they compare names'
  for (const segment of segments) {
    if (segment.length > SEGMENT_CAP) return 'a segment longer than 255 characters'
    if (segment === '..') return 'a .. segment'
    if (segment === '' || segment === '.') return 'an empty or . segment'
    if (segment.endsWith('.') || segment.endsWith(' ')) return 'a trailing dot or space'
    if (device.test(segment)) return 'a Windows device name'
  }
  return null
}

// The names taken so far, folded as a volume that ignores case and Unicode form compares them. A file may not stand
// where another entry needs a folder. A folder entry may repeat, a file may not
class Taken {
  readonly #files = new Set<string>()
  readonly #folders = new Set<string>()

  // How many names the entry adds, every folder its name implies counted, or null when it is taken
  claim(name: string, folder: boolean): number | null {
    const segments = name.normalize('NFC').toLowerCase().split('/')
    const parents = segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join('/'))
    const key = segments.join('/')
    if (parents.some(parent => this.#files.has(parent)) || this.#files.has(key)) return null
    if (!folder && this.#folders.has(key)) return null
    const before = this.#files.size + this.#folders.size
    for (const parent of parents) this.#folders.add(parent)
    if (folder) this.#folders.add(key)
    else this.#files.add(key)
    return this.#files.size + this.#folders.size - before
  }
}

// Every entry from either source passes through here: its name checked and claimed, every new name counted toward the
// entry cap and every byte toward the byte cap as it is written, each file opened as new. The bytes are counted as they
// come out of the source and checked before each chunk is written, so the folder never holds more than the cap
class Writer {
  readonly #into: string
  readonly #limits: UnpackLimits
  readonly #taken = new Taken()
  #count = 0
  #written = 0

  constructor(into: string, limits: UnpackLimits) {
    this.#into = into
    this.#limits = limits
  }

  #claim(name: string, folder: boolean): string {
    if (nameProblem(name) !== null) throw new Refused('name')
    const added = this.#taken.claim(name, folder)
    if (added === null) throw new Refused('duplicate')
    this.#count += added
    if (this.#count > this.#limits.entries) throw new Refused('too-many')
    return path.join(this.#into, ...name.split('/'))
  }

  async folder(name: string): Promise<void> {
    await mkdir(this.#claim(name, true), { recursive: true })
  }

  async file(name: string, data: () => Promise<AsyncIterable<Buffer>>): Promise<void> {
    const target = this.#claim(name, false)
    await mkdir(path.dirname(target), { recursive: true })
    const file = await open(target, 'wx')
    try {
      for await (const chunk of await data()) {
        this.#written += chunk.length
        if (this.#written > this.#limits.bytes) throw new Refused('too-big')
        // A write may take part of the chunk, so it goes on from where the last one stopped
        for (let at = 0; at < chunk.length;) at += (await file.write(chunk, at)).bytesWritten
      }
    } finally {
      await file.close()
    }
  }
}

// The Finder's Compress puts each file's resource fork and extended attributes in AppleDouble files under __MACOSX/ at
// the top of the zip. No plugin runs them, so they are skipped rather than written into a plugin and its hash. A
// __MACOSX folder anywhere else is an ordinary folder
const resourceForks = (name: string) => name === '__MACOSX' || name.startsWith('__MACOSX/')

// The reader's own failures, each a zip refused as invalid
async function fromZip<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch {
    throw new Refused('invalid')
  }
}

async function* chunksOf(data: Readable): AsyncGenerator<Buffer> {
  try {
    for await (const chunk of data) yield chunk
  } catch {
    throw new Refused('invalid')
  }
}

function special(entry: Entry, folder: boolean): boolean {
  const type = (entry.externalFileAttributes >>> 16) & TYPE
  if (type !== 0 && type !== (folder ? FOLDER : FILE)) return true
  return (entry.externalFileAttributes & REPARSE_POINT) !== 0
}

async function zipInto(zip: Buffer, writer: Writer, limits: UnpackLimits): Promise<void> {
  const zipfile: ZipFile = await fromZip(fromBufferPromise(zip, READER))
  const entries = zipfile.eachEntry()
  try {
    // The reader reads exactly the count the zip declares, so a zip past the cap is refused before any entry is read
    if (zipfile.entryCount > limits.entries) throw new Refused('too-many')
    for (;;) {
      const next = await fromZip(entries.next())
      if (next.done === true) return
      const entry = next.value
      const folder = entry.fileName.endsWith('/')
      const name = folder ? entry.fileName.slice(0, -1) : entry.fileName
      if (resourceForks(name)) continue
      if (special(entry, folder)) throw new Refused('special')
      if ((entry.generalPurposeBitFlag & ENCRYPTED) !== 0) throw new Refused('encrypted')
      if (folder) await writer.folder(name)
      else await writer.file(name, async () => chunksOf(await fromZip(zipfile.openReadStreamPromise(entry))))
    }
  } finally {
    await entries.return?.()
    zipfile.close()
  }
}

// O_NOFOLLOW where the platform has one, so a file swapped for a link after the listing isn't read through the link
const READ_ONLY = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

async function* readFrom(file: string): AsyncGenerator<Buffer> {
  const handle = await open(file, READ_ONLY)
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) yield chunk
  } finally {
    await handle.close()
  }
}

// Each entry of a picked folder as its listing names it, a link or anything else neither file nor folder refused. The
// depth cap in nameProblem bounds the recursion
async function folderInto(dir: string, prefix: string, writer: Writer): Promise<void> {
  for await (const entry of await opendir(dir)) {
    const name = prefix + entry.name
    const from = path.join(dir, entry.name)
    if (resourceForks(name)) continue
    if (entry.isDirectory()) {
      await writer.folder(name)
      await folderInto(from, `${name}/`, writer)
    } else if (entry.isFile()) {
      await writer.file(name, async () => readFrom(from))
    } else {
      throw new Refused('special')
    }
  }
}

// Whether the path is a folder and no link to one. One that can't be looked at, a missing one among them, is not
export const isRealFolder = (dir: string) => lstat(dir).then(stat => stat.isDirectory(), () => false)

// Empties the staging folder after a refusal or a failure, answering whether something may be left
async function emptied(into: string): Promise<boolean> {
  try {
    for (const name of await readdir(into)) await clear(path.join(into, name))
    return true
  } catch {
    // The clear's own error is dropped: the refusal or the failure that started it is the answer, with leftovers set
    return false
  }
}

// Fills an empty staging folder from one source. A folder that isn't empty is the caller's mistake and throws. A
// refusal empties the folder and says when that failed. Any other failure throws its own error after the same attempt,
// so a caller removes the staging folder itself on a throw
async function staged(into: string, limits: UnpackLimits, fill: (writer: Writer) => Promise<void>): Promise<Staged> {
  if (!(await lstat(into)).isDirectory() || (await readdir(into)).length > 0) throw new Error('staging takes an empty folder')
  try {
    await fill(new Writer(into, limits))
    return { problem: null, leftovers: false }
  } catch (err) {
    const leftovers = !(await emptied(into))
    if (err instanceof Refused) return { problem: err.problem, leftovers }
    throw err
  }
}

// Unpacks a plugin zip into an empty staging folder, read once from the bytes handed in. Every name is checked before
// anything is written for it and every file is opened as new, so nothing is overwritten and nothing lands outside the
// folder
export async function unpackZip(zip: Buffer, into: string, limits: UnpackLimits = unpackLimits): Promise<Staged> {
  return staged(into, limits, writer => zipInto(zip, writer, limits))
}

// Copies a folder the human picked into an empty staging folder under the same checks and caps as a zip, so what is
// read and hashed after is only ever the copy. A picked folder that is missing, a file or a link is refused
export async function stageFolder(from: string, into: string, limits: UnpackLimits = unpackLimits): Promise<Staged> {
  return staged(into, limits, async writer => {
    if (!(await isRealFolder(from))) throw new Refused('not-a-folder')
    await folderInto(from, '', writer)
  })
}
