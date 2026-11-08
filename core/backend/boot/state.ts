import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { folderCapabilities, screenText } from '../../api/capabilities.ts'
import { MAX_FOLDER_LENGTH } from '../../api/changes.ts'
import { floorConstantNames, MAX_TIMER_MS, timeConstants } from '../../api/floor.ts'
import { firstPartyIds, installIds, isReservedId, pluginId } from '../../api/ids.ts'
import { retried, syncDir, writable } from '../../lib/disk.ts'
import { checkHash, parseStrict, replaceFile, withHash } from '../../lib/hashed-file.ts'

// The format this build reads and writes. A file in a later one belongs to a newer build. From format 3 on, boot keeps
// a reader for the format before
export const FORMAT = 2
// Entries in one list or map of the switches that names plugins. More than one machine runs, since each community
// plugin gets a renderer of about 70 MB
export const MAX_LISTED = 256

const text = z.string().min(1)
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

const installId = z.enum(installIds)
const firstPartyId = z.enum(firstPartyIds)
// An id some plugin can hold: an install or first-party id, or one the reserved list leaves to community plugins. The
// namespaces the core serves, cache included, name no plugin
const anyPlugin = pluginId.refine(
  id => !isReservedId(id) || installId.safeParse(id).success || firstPartyId.safeParse(id).success,
  'an id no plugin holds',
)

// No entry twice, so a list reads one way
function list<T extends z.ZodType<string>>(item: T) {
  return z.array(item)
    .max(MAX_LISTED, { abort: true })
    .refine(items => new Set(items).size === items.length, 'an entry twice')
}

// No prototype, so a plugin id can't find Object's own members in place of an entry
function table<T extends object>(entries: T): T {
  return Object.assign(Object.create(null), entries)
}

// A record drops an own __proto__ key without a word, so a write would lose the entry instead of refusing the input
const noProtoKey = z.unknown().superRefine((input, ctx) => {
  if (typeof input === 'object' && input !== null && Object.hasOwn(input, '__proto__')) {
    ctx.addIssue({ code: 'custom', message: 'a __proto__ key' })
  }
})

function map<T extends z.ZodType<object>>(record: T) {
  return noProtoKey.pipe(record).transform(entries => table(entries))
}

// The human's value per floor constant, above the fixed value or below. A time stops at the longest delay a timer
// takes, as limit.set has it
const values = map(z.partialRecord(z.enum(floorConstantNames), z.int().positive()).refine(
  entries => Object.entries(entries).every(([name, value]) =>
    !(timeConstants as readonly string[]).includes(name) || value <= MAX_TIMER_MS),
  `a time past ${MAX_TIMER_MS} ms`,
))
const limits = z.strictObject({
  all: values,
  plugins: map(z.record(anyPlugin, values).refine(
    entries => Object.keys(entries).length <= MAX_LISTED,
    `more than ${MAX_LISTED} plugins`,
  )),
})

// What each file holds, in the shape callers see. The writers take exactly this shape and add the format number
const switches = z.strictObject({
  off: list(installId), // an install plugin not named here is on, so a lost entry can't read as off
  devMode: list(anyPlugin), // load unhashed with live reload
  skipVerification: z.boolean(),
  allowUnsigned: z.array(sha256Hex), // builds pinned by content hash
  confirmOff: z.boolean(), // only for changes made in the trusted window's own plugin list
  removed: list(firstPartyId), // tombstones, which the reconcile never copies back
  execAnyCommand: list(anyPlugin), // plugins exec runs any command for, past the declared list
  limits,
  recordNothing: z.boolean(),
})
const plugin = z.strictObject({
  version: text,
  contentHash: sha256Hex,
  signer: text.nullable(), // null only for a plugin on allowUnsigned
  granted: folderCapabilities, // entries are for folder plugins only, which never hold an install-only type
  class: z.int().min(0).max(4).nullable(), // null until classified, which counts as 4
  enabled: z.boolean(), // the human's switch, which no check changes
  // Items of granted the human switched off, each as granted holds it. Left out of an entry written before the switches
  // came, which then has none off. One granted doesn't hold switches nothing off
  off: folderCapabilities.optional(),
})

// Absolute by the rules of the platform the folder is on. On Windows a drive or a share: Windows reads \notes against
// whichever drive is current, which Node's isAbsolute takes as absolute
function absoluteOn(platform: string, folder: string): boolean {
  if (platform === 'win32') return /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(folder)
  return path.posix.isAbsolute(folder)
}

function luoshuFor(platform: string) {
  return z.strictObject({
    folder: screenText(MAX_FOLDER_LENGTH).refine(folder => absoluteOn(platform, folder), 'not an absolute path'),
  })
}

const format = z.literal(FORMAT)
const switchesFile = z.strictObject({ format, ...switches.shape })
const pluginFile = z.strictObject({ format, ...plugin.shape })

export type Switches = z.infer<typeof switches>
export type Plugin = z.infer<typeof plugin>
export type Luoshu = z.infer<ReturnType<typeof luoshuFor>>
// luoshu is null until a folder is picked
export type SecurityState = { plugins: Record<string, Plugin>, switches: Switches, luoshu: Luoshu | null }

// newer is a file in a later format, read no further and never written over
export type FileResult = 'ok' | 'absent' | 'hash-missing' | 'hash-mismatch' | 'invalid' | 'unreadable' | 'newer'
// id is the plugin and is left out when the plugins folder itself can't be listed
export type Check = {
  check: 'switches' | 'luoshu' | 'plugin-entry'
  id?: string
  result: FileResult
}

// state is what to run with. After a failed check state differs from the files and must not be written back as is.
// removedKnown is true only when removed came from a switches file that checked out. With that file absent, failed or
// newer the defaults name no tombstone, so a first-party plugin with no entry may be one the human removed
export type Loaded = { state: SecurityState, suspect: boolean, checks: Check[], removedKnown: boolean }

// Loosens nothing: every install plugin on, empty lists, false switches and no raised limits
export function defaultSwitches(): Switches {
  return {
    off: [],
    devMode: [],
    skipVerification: false,
    allowUnsigned: [],
    confirmOff: false,
    removed: [],
    execAnyCommand: [],
    limits: { all: table({}), plugins: table({}) },
    recordNothing: false,
  }
}

export function defaultState(): SecurityState {
  return { plugins: table({}), switches: defaultSwitches(), luoshu: null }
}

function absolute(value: string | undefined, name: string): string {
  if (!value || !path.posix.isAbsolute(value)) throw new Error(`${name} is not an absolute path`)
  return value
}

// determine local folder path, not roaming, so the state stays on this machine. 
// folder name is hetu-dev for an unpackaged run
export function stateDir(platform: string = process.platform, env: Record<string, string | undefined> = process.env, name = 'hetu'): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    if (!local || !path.win32.isAbsolute(local)) throw new Error('LOCALAPPDATA is not an absolute path')
    return path.win32.join(local, name)
  }
  if (platform === 'darwin') return path.posix.join(absolute(env.HOME, 'HOME'), 'Library', 'Application Support', name) // mac
  if (platform === 'linux') {
    // A bad XDG_STATE_HOME is refused, not skipped, or a typo would move the state without a word
    const base = env.XDG_STATE_HOME === undefined
      ? path.posix.join(absolute(env.HOME, 'HOME'), '.local', 'state')
      : absolute(env.XDG_STATE_HOME, 'XDG_STATE_HOME')
    return path.posix.join(base, name)
  }
  throw new Error(`no security state location on ${platform}`)
}

// A short hold by antivirus at boot would otherwise read as unreadable and suspect
async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await retried(() => readFile(file), file, 'read')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

// A later build's file. Any other format, 1 included, has no reader here and reads as invalid
function laterFormat(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'format')) return false
  const found = (value as { format: unknown }).format
  return typeof found === 'number' && Number.isSafeInteger(found) && found > FORMAT
}

type Read<T extends z.ZodType> = { result: FileResult, value?: z.output<T> }

// Each file stands or falls alone, with the hash checked over the raw bytes before any parsing
async function readChecked<T extends z.ZodType>(file: string, schema: T): Promise<Read<T>> {
  let bytes: Buffer | null
  try {
    bytes = await readIfExists(file)
  } catch {
    return { result: 'unreadable' }
  }
  // A wiped file reads the same as a new install, threat 55
  if (bytes === null) return { result: 'absent' }
  const checked = checkHash(bytes)
  if ('result' in checked) return checked
  let value: unknown
  try {
    value = parseStrict(checked.body, z.unknown())
  } catch {
    return { result: 'invalid' }
  }
  if (laterFormat(value)) return { result: 'newer' }
  const parsed = schema.safeParse(value)
  return parsed.success ? { result: 'ok', value: parsed.data } : { result: 'invalid' }
}

// The format number belongs to the file, not to what runs
function withoutFormat<T extends { format: typeof FORMAT }>(file: T): Omit<T, 'format'> {
  const { format, ...rest } = file
  return rest
}

// What Finder and Explorer leave in a folder the user only looked at. Never read, so they can't stand in for an entry
const osFiles = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

// Plugin ids come from file names here, so a name that is not <id>.json with a good id is reported
function sortEntryNames(names: string[]): { ids: string[]; invalid: string[] } {
  const ids = new Set<string>()
  const invalid = new Set<string>()
  for (const name of names) {
    if (name.endsWith('.tmp')) continue // what a crashed write leaves, never read
    if (osFiles.has(name.toLowerCase())) continue
    const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : null
    if (id !== null && pluginId.safeParse(id).success) ids.add(id)
    else invalid.add(id || name)
  }
  return { ids: [...ids].sort(), invalid: [...invalid].sort() }
}

// The one writer of the security state. Detect only against a program running as the user: the hash
// catches edits by anything that doesn't know hetu, not one that rewrites the hash or restores an old copy
export class StateStore {
  private readonly dir: string
  private readonly luoshu: ReturnType<typeof luoshuFor>
  private readonly luoshuFile: z.ZodType<Luoshu & { format: typeof FORMAT }>
  // Files a load found in a later format. Held for the rest of the run, so an older build never writes over a newer
  // state
  private readonly newer = new Set<string>()
  private tail: Promise<unknown> = Promise.resolve()

  // platform gives the rules the luoshu folder must be absolute by
  constructor(dir: string, platform: string = process.platform) {
    this.dir = dir
    this.luoshu = luoshuFor(platform)
    this.luoshuFile = z.strictObject({ format, ...this.luoshu.shape })
  }

  private file(...parts: string[]) {
    return path.join(this.dir, 'state', ...parts)
  }

  // Overlapping calls would land in any order, and a load could read between them
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work)
    this.tail = run.catch(() => {})
    return run
  }

  // Checked inside the queue, so a write queued behind a load meets what that load found
  private refuseNewer(file: string): void {
    if (this.newer.has(file)) throw new Error(`${path.basename(file)} is in a newer format than this build writes`)
  }

  private async put(file: string, content: object): Promise<void> {
    const bytes = withHash(Buffer.from(`${JSON.stringify({ format: FORMAT, ...content }, null, 2)}\n`))
    await this.serial(async () => {
      this.refuseNewer(file)
      await mkdir(path.dirname(file), { recursive: true })
      // A folder in the way is left for manual cleanup and the write fails closed, with the old file as it was
      await writable(file)
      await replaceFile(file, bytes)
    })
  }

  async writeSwitches(input: unknown): Promise<void> {
    await this.put(this.file('switches.json'), switches.parse(input))
  }

  async writeLuoshu(input: unknown): Promise<void> {
    await this.put(this.file('luoshu.json'), this.luoshu.parse(input))
  }

  async writePlugin(id: string, input: unknown): Promise<void> {
    const entry = plugin.parse(input)
    await this.put(this.file('plugins', `${pluginId.parse(id)}.json`), entry)
  }

  async removePlugin(id: string): Promise<void> {
    const file = this.file('plugins', `${pluginId.parse(id)}.json`)
    await this.serial(async () => {
      this.refuseNewer(file)
      // No target for the read-only check: rm deletes a read-only file by itself, and a folder throws EISDIR, no lock
      await retried(() => rm(file, { force: true }))
      await syncDir(path.dirname(file))
    })
  }

  // The bytes of the switches, the luoshu and the named plugin's entry as one digest, read in the queue so it follows
  // every write already asked for. A held security request compares it at its Confirm, so a change or an edit made
  // between the request and the click answers stale. An absent or unreadable file counts as what it is
  fingerprint(plugin: string | null): Promise<string> {
    return this.serial(async () => {
      const files = [this.file('switches.json'), this.file('luoshu.json')]
      if (plugin !== null) files.push(this.file('plugins', `${pluginId.parse(plugin)}.json`))
      const digest = createHash('sha256')
      for (const file of files) {
        const bytes = await readFile(file).then(read => createHash('sha256').update(read).digest('hex'), (err: NodeJS.ErrnoException) => err.code === 'ENOENT' ? 'absent' : 'unreadable')
        digest.update(`${bytes}
`)
      }
      return digest.digest('hex')
    })
  }

  // Never writes: a bad file stays as found until the next write of the same file
  load(): Promise<Loaded> {
    return this.serial(() => this.read())
  }

  private async checkFile<T extends z.ZodType>(file: string, schema: T): Promise<Read<T>> {
    const read = await readChecked(file, schema)
    if (read.result === 'newer') this.newer.add(file)
    return read
  }

  private async read(): Promise<Loaded> {
    const state = defaultState()
    const checks: Check[] = []

    // A bad or missing switches file never touches the luoshu and a bad luoshu file never touches the switches
    const switchesRead = await this.checkFile(this.file('switches.json'), switchesFile)
    checks.push({ check: 'switches', result: switchesRead.result })
    if (switchesRead.value) state.switches = withoutFormat(switchesRead.value)

    // Absent is a luoshu not picked yet
    const luoshuRead = await this.checkFile(this.file('luoshu.json'), this.luoshuFile)
    checks.push({ check: 'luoshu', result: luoshuRead.result })
    if (luoshuRead.value) state.luoshu = withoutFormat(luoshuRead.value)

    await this.readPlugins(state, checks)

    // A newer file is a newer build's state under an older build, which the banner shows, not tampering
    const suspect = checks.some(c => c.result !== 'ok' && c.result !== 'absent' && c.result !== 'newer')
    return { state, suspect, checks, removedKnown: switchesRead.result === 'ok' }
  }

  // Entries only. The plugin files check is the loader's, which reads the bytes that run, so nothing here changes
  // enabled
  private async readPlugins(state: SecurityState, checks: Check[]): Promise<void> {
    let names: string[] = []
    try {
      names = await readdir(this.file('plugins'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') checks.push({ check: 'plugin-entry', result: 'unreadable' })
    }
    const { ids, invalid } = sortEntryNames(names)
    for (const id of invalid) checks.push({ check: 'plugin-entry', id, result: 'invalid' })
    for (const id of ids) {
      const read = await this.checkFile(this.file('plugins', `${id}.json`), pluginFile)
      checks.push({ check: 'plugin-entry', id, result: read.result })
      // With no valid entry there is no hash to check the code against, so the plugin is left out
      if (read.value) state.plugins[id] = withoutFormat(read.value)
    }
  }
}
