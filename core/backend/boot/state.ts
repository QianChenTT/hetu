import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { evaluate, parse } from '@humanwhocodes/momoa'
import { z } from 'zod'
import { retried, syncDir, writable } from '../disk.ts'

const text = z.string().min(1)
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
// Becomes a folder name under plugins/: no separators, no dot at either end for Windows to drop. Windows device names
// are refused alone or before a dot on every platform, since tools such as PowerShell 5.1 can't delete such a folder
const pluginId = z.string()
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
  .refine(id => !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(id), 'a Windows device name')

// The fixed list from the core design, a new type needs a new core API version
const capability = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal(['vault.read', 'vault.write']), paths: z.array(text) }),
  z.strictObject({ type: z.literal('net.fetch'), hosts: z.array(text) }),
  z.strictObject({ type: z.literal(['ui.panel', 'ui.decoration', 'ui.command', 'ui.statusBar']) }),
  z.strictObject({ type: z.literal('events.subscribe'), topics: z.array(text) }),
  z.strictObject({ type: z.literal('storage') }),
  z.strictObject({ type: z.literal('history'), access: z.enum(['read', 'commit']) }),
  z.strictObject({ type: z.literal('exec'), commands: z.array(z.array(text).min(1)), env: z.array(text) }),
])

// What each file holds, in the shape callers see. The writers take exactly this shape and add the format number
const switches = z.strictObject({
  guardsOff: z.array(pluginId), // a guard not named here is on, so a lost entry can't read as off
  devMode: z.boolean(),
  skipVerification: z.boolean(),
  allowUnsigned: z.array(sha256Hex),
})
const agents = z.record(text, z.strictObject({ grants: z.array(capability) }))
const plugin = z.strictObject({
  version: text,
  contentHash: sha256Hex,
  signer: text.nullable(), // null only for a plugin on allowUnsigned
  granted: z.array(capability),
  class: z.int().min(0).max(4),
  enabled: z.boolean(),
})

const format = z.literal(1)
const switchesFile = z.strictObject({ format, ...switches.shape })
const agentsFile = z.strictObject({ format, agents })
const pluginFile = z.strictObject({ format, ...plugin.shape })

export type Switches = z.infer<typeof switches>
export type Agents = z.infer<typeof agents>
export type Plugin = z.infer<typeof plugin>
export type SecurityState = { plugins: Record<string, Plugin>, switches: Switches, agents: Agents }

export type FileResult = 'ok' | 'absent' | 'hash-missing' | 'hash-mismatch' | 'invalid' | 'unreadable'
export type FilesResult = 'ok' | 'mismatch' | 'missing' | 'unreadable'
// id is the plugin and is left out when the plugins folder itself can't be listed
export type Check = {
  check: 'switches' | 'agents' | 'plugin-entry' | 'plugin-files'
  id?: string
  result: FileResult | FilesResult
}

// state is what to run with. After a failed check state differs from the files and must not be written back as is
export type Loaded = { state: SecurityState; suspect: boolean; checks: Check[] }

// No prototype, so a name an agent picks can't find Object's own members in place of an entry
function table<T>(entries: Record<string, T> = {}): Record<string, T> {
  return Object.assign(Object.create(null), entries)
}

export function defaultState(): SecurityState {
  return {
    plugins: table(),
    switches: { guardsOff: [], devMode: false, skipVerification: false, allowUnsigned: [] },
    agents: table(),
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

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

type Node = ReturnType<typeof parse>['body']

// JSON.parse keeps the last duplicate silently, so the approval screen and the loader could read different values
function rejectBadKeys(node: Node): void {
  if (node.type === 'Array') {
    for (const element of node.elements) rejectBadKeys(element.value)
  } else if (node.type === 'Object') {
    const seen = new Set<string>()
    for (const member of node.members) {
      const name = member.name.type === 'String' ? member.name.value : member.name.name
      if (seen.has(name)) throw new Error('duplicate key')
      if (name === '__proto__') throw new Error('__proto__ key')
      seen.add(name)
      rejectBadKeys(member.value)
    }
  }
}

// One parser for the key check and the values, so the two can't disagree about the bytes
function parseStrict<T extends z.ZodType>(bytes: Buffer, schema: T): z.output<T> {
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const document = parse(source)
  rejectBadKeys(document.body)
  return schema.parse(evaluate(document))
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

// A crash leaves the old file or the new one, never half of either
async function replaceFile(file: string, bytes: Buffer | string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temp, 'wx')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await retried(() => rename(temp, file), file)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
  await syncDir(path.dirname(file))
}

// The hash sits on a file's last line, over every byte before it, so one rename writes the state and its hash together
// and nothing can leave a new file beside an old hash
function withHash(body: Buffer): Buffer {
  return Buffer.concat([body, Buffer.from(`${sha256(body)}\n`)])
}

// The body above the hash line, or why the file doesn't check out. A last line that isn't a hash means there is none,
// one that is must be exactly the lowercase hash of the bytes before it with one newline after
function checkHash(bytes: Buffer): { body: Buffer } | { result: 'hash-missing' | 'hash-mismatch' } {
  const end = bytes.at(-1) === 0x0a ? bytes.length - 1 : bytes.length
  const start = end > 0 ? bytes.lastIndexOf(0x0a, end - 1) + 1 : 0
  const line = bytes.subarray(start, end).toString('latin1')
  if (start === 0 || !/^[0-9a-f]{64}$/i.test(line)) return { result: 'hash-missing' }
  const body = bytes.subarray(0, start)
  if (end === bytes.length || line !== sha256(body)) return { result: 'hash-mismatch' }
  return { body }
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

  async writeAgents(input: unknown): Promise<void> {
    // The record parse drops a __proto__ key without a word, which would lose that agent from the file
    if (typeof input === 'object' && input !== null && Object.hasOwn(input, '__proto__')) throw new Error('__proto__ is not an agent name')
    await this.put(this.file('agents.json'), { format: 1, agents: agents.parse(input) })
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

    const agentsRead = await readChecked(this.file('agents.json'), agentsFile)
    checks.push({ check: 'agents', result: agentsRead.result })
    if (agentsRead.value) state.agents = table(agentsRead.value.agents)

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
