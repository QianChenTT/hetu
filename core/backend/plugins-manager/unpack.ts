import { lstat, mkdir, open, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { fromBufferPromise, type Entry, type ZipFile } from 'yauzl'
import { withoutIgnorable } from '../../api/names.ts'
import { clear } from './folders.ts'

// The most one plugin zip may unpack to: entries, every folder a name implies among them, and bytes as written to disk
export type UnpackLimits = { entries: number, bytes: number }
export const unpackLimits: UnpackLimits = Object.freeze({ entries: 2000, bytes: 64 * 1024 * 1024 })

// What one name may hold. NTFS and most volumes take 255 UTF-16 units a segment. The depth and the length keep every
// path one that Windows tools can still delete
const NAME_CAP = 1024
const SEGMENT_CAP = 255
const DEPTH_CAP = 32

// Why a zip was refused. invalid: no zip the reader takes, a name the reader refuses, data that won't inflate or a size
// it declares that its data doesn't have. special: a link, a device, a pipe or a socket, or a type that disagrees with
// the name
export type UnpackProblem = 'invalid' | 'name' | 'duplicate' | 'special' | 'encrypted' | 'too-many' | 'too-big'

class Refused extends Error {
  readonly problem: UnpackProblem

  constructor(problem: UnpackProblem) {
    super(problem)
    this.problem = problem
  }
}

// The reader checks names, sizes and backslashes itself. The checks here run again on every name it hands over
const READER = { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true } as const

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

function special(entry: Entry, folder: boolean): boolean {
  const type = (entry.externalFileAttributes >>> 16) & TYPE
  if (type !== 0 && type !== (folder ? FOLDER : FILE)) return true
  return (entry.externalFileAttributes & REPARSE_POINT) !== 0
}

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

// Writes one entry's data to a new file and answers the bytes written so far. The count is of the bytes that come out
// of the reader, checked before each chunk is written, so the folder never holds more than the cap
async function writeEntry(zipfile: ZipFile, entry: Entry, target: string, written: number, cap: number): Promise<number> {
  const file = await open(target, 'wx')
  try {
    for await (const chunk of chunksOf(await fromZip(zipfile.openReadStreamPromise(entry)))) {
      written += chunk.length
      if (written > cap) throw new Refused('too-big')
      await file.write(chunk)
    }
  } finally {
    await file.close()
  }
  return written
}

async function unpack(zip: Buffer, into: string, limits: UnpackLimits): Promise<void> {
  const zipfile = await fromZip(fromBufferPromise(zip, READER))
  const entries = zipfile.eachEntry()
  try {
    // The reader reads exactly the count the zip declares
    if (zipfile.entryCount > limits.entries) throw new Refused('too-many')
    const taken = new Taken()
    let count = 0
    let written = 0
    for (;;) {
      const next = await fromZip(entries.next())
      if (next.done === true) return
      const entry = next.value
      const folder = entry.fileName.endsWith('/')
      const name = folder ? entry.fileName.slice(0, -1) : entry.fileName
      if (nameProblem(name) !== null) throw new Refused('name')
      if (special(entry, folder)) throw new Refused('special')
      if ((entry.generalPurposeBitFlag & ENCRYPTED) !== 0) throw new Refused('encrypted')
      const added = taken.claim(name, folder)
      if (added === null) throw new Refused('duplicate')
      count += added
      if (count > limits.entries) throw new Refused('too-many')
      const target = path.join(into, ...name.split('/'))
      if (folder) {
        await mkdir(target, { recursive: true })
        continue
      }
      await mkdir(path.dirname(target), { recursive: true })
      written = await writeEntry(zipfile, entry, target, written, limits.bytes)
    }
  } finally {
    await entries.return?.()
    zipfile.close()
  }
}

// Unpacks a plugin zip into an empty staging folder, read once from the bytes handed in. Every name is checked before
// anything is written for it and every file is opened as new, so nothing is overwritten and nothing lands outside the
// folder. A refusal or a failure leaves the folder empty. A folder that isn't empty is the caller's mistake and throws
export async function unpackZip(zip: Buffer, into: string, limits: UnpackLimits = unpackLimits): Promise<UnpackProblem | null> {
  if (!(await lstat(into)).isDirectory() || (await readdir(into)).length > 0) throw new Error('unpack takes an empty folder')
  try {
    await unpack(zip, into, limits)
    return null
  } catch (err) {
    for (const name of await readdir(into)) await clear(path.join(into, name))
    if (err instanceof Refused) return err.problem
    throw err
  }
}
