import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { folderCapability } from '../../api/capabilities.ts'
import { pluginId } from '../../api/ids.ts'
import { retried, syncDir, writable } from '../../lib/disk.ts'
import { checkHash, parseStrict, replaceFile, withHash } from '../../lib/hashed-file.ts'

const text = z.string().min(1)
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

// What each file holds, in the shape callers see. The writers take exactly this shape and add the format number
const switches = z.strictObject({
  guardsOff: z.array(pluginId), // a guard not named here is on, so a lost entry can't read as off
  devMode: z.boolean(),
  skipVerification: z.boolean(),
  allowUnsigned: z.array(sha256Hex),
})
const plugin = z.strictObject({
  version: text,
  contentHash: sha256Hex,
  signer: text.nullable(), // null only for a plugin on allowUnsigned
  granted: z.array(folderCapability), // entries are for folder plugins only, which never hold an install-only type
  class: z.int().min(0).max(4),
  enabled: z.boolean(),
})

const format = z.literal(1)
const switchesFile = z.strictObject({ format, ...switches.shape })
const pluginFile = z.strictObject({ format, ...plugin.shape })

export type Switches = z.infer<typeof switches>
export type Plugin = z.infer<typeof plugin>
export type SecurityState = { plugins: Record<string, Plugin>, switches: Switches }

export type FileResult = 'ok' | 'absent' | 'hash-missing' | 'hash-mismatch' | 'invalid' | 'unreadable'
export type FilesResult = 'ok' | 'mismatch' | 'missing' | 'unreadable'
// id is the plugin and is left out when the plugins folder itself can't be listed
export type Check = {
  check: 'switches' | 'plugin-entry' | 'plugin-files'
  id?: string
  result: FileResult | FilesResult
}

// state is what to run with. After a failed check state differs from the files and must not be written back as is
export type Loaded = { state: SecurityState; suspect: boolean; checks: Check[] }

// No prototype, so a plugin id can't find Object's own members in place of an entry
function table<T>(entries: Record<string, T> = {}): Record<string, T> {
  return Object.assign(Object.create(null), entries)
}

export function defaultState(): SecurityState {
  return {
    plugins: table(),
    switches: { guardsOff: [], devMode: false, skipVerification: false, allowUnsigned: [] },
  }
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

// Each file stands or falls alone, with the hash checked over the raw bytes before any parsing
async function readChecked<T extends z.ZodType>(file: string, schema: T): Promise<{ result: FileResult; value?: z.output<T> }> {
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
  try {
    return { result: 'ok', value: parseStrict(checked.body, schema) }
  } catch {
    return { result: 'invalid' }
  }
}

// The format number belongs to the file, not to what runs
function withoutFormat<T extends { format: 1 }>(file: T): Omit<T, 'format'> {
  const { format, ...rest } = file
  return rest
}

async function listFiles(dir: string, prefix: string, files: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name
    if (entry.isDirectory()) await listFiles(path.join(dir, entry.name), `${rel}/`, files)
    else if (entry.isFile()) files.push(rel)
    else throw new Error(`not a file or folder: ${rel}`) // a link would pull in bytes from outside the plugin
  }
}

// Path and size frame each file, so moving bytes across a file boundary changes the hash
export async function contentHash(root: string): Promise<string> {
  const stat = await lstat(root)
  if (!stat.isDirectory()) throw new Error('plugin folder is not a folder')
  const files: string[] = []
  await listFiles(root, '', files)
  const digest = createHash('sha256')
  for (const rel of files.sort()) {
    const file = path.join(root, rel)
    const bytes = await retried(() => readFile(file), file, 'read')
    digest.update(`${rel}\0${bytes.length}\0`).update(bytes)
  }
  return digest.digest('hex')
}

async function checkPluginFiles(root: string, expected: string): Promise<FilesResult> {
  try {
    return (await contentHash(root)) === expected ? 'ok' : 'mismatch'
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
  }
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
  private tail: Promise<unknown> = Promise.resolve()

  constructor(dir: string) {
    this.dir = dir
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

  private async put(file: string, content: object): Promise<void> {
    const bytes = withHash(Buffer.from(`${JSON.stringify(content, null, 2)}\n`))
    await this.serial(async () => {
      await mkdir(path.dirname(file), { recursive: true })
      // A folder in the way is left for manual cleanup and the write fails closed, with the old file as it was
      await writable(file)
      await replaceFile(file, bytes)
    })
  }

  async writeSwitches(input: unknown): Promise<void> {
    await this.put(this.file('switches.json'), { format: 1, ...switches.parse(input) })
  }

  async writePlugin(id: string, input: unknown): Promise<void> {
    const entry = plugin.parse(input)
    await this.put(this.file('plugins', `${pluginId.parse(id)}.json`), { format: 1, ...entry })
  }

  async removePlugin(id: string): Promise<void> {
    const file = this.file('plugins', `${pluginId.parse(id)}.json`)
    await this.serial(async () => {
      // No target for the read-only check: rm deletes a read-only file by itself, and a folder throws EISDIR, no lock
      await retried(() => rm(file, { force: true }))
      await syncDir(path.dirname(file))
    })
  }

  // Never writes: a bad file stays as found until the next write of the same file
  load(): Promise<Loaded> {
    return this.serial(() => this.read())
  }

  private async read(): Promise<Loaded> {
    const state = defaultState()
    const checks: Check[] = []

    const switchesRead = await readChecked(this.file('switches.json'), switchesFile)
    checks.push({ check: 'switches', result: switchesRead.result })
    if (switchesRead.value) state.switches = withoutFormat(switchesRead.value)

    await this.readPlugins(state, checks)

    const suspect = checks.some(c => c.result !== 'ok' && c.result !== 'absent')
    return { state, suspect, checks }
  }

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
      const read = await readChecked(this.file('plugins', `${id}.json`), pluginFile)
      checks.push({ check: 'plugin-entry', id, result: read.result })
      // With no valid entry there is no hash to check the code against, so the plugin is left out
      if (!read.value) continue
      const entry = withoutFormat(read.value)
      const files = await checkPluginFiles(path.join(this.dir, 'plugins', id), entry.contentHash)
      checks.push({ check: 'plugin-files', id, result: files })
      if (files !== 'ok') entry.enabled = false
      state.plugins[id] = entry
    }
  }
}
