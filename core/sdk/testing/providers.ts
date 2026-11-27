import { createHash } from 'node:crypto'
import { LIST_PAGE, type HistoryCommit, type ResultOf } from '../../api/actions.ts'
import type { RefusalCode } from '../../api/envelope.ts'
import { HISTORY_COMMIT_BYTES, HISTORY_FILE_BYTES, LOG_PAGE } from '../../api/exec.ts'
import { isDotName } from '../../api/names.ts'
import { signatureOf, type Call, type Guard, type Prepared, type Provider, type ProviderRefusal } from '../../api/policy-jobs.ts'
import { quotas, spaceOf } from '../../api/storage.ts'
import type { LockOptions } from '../../backend/lock/header.ts'
import { createLock } from '../../backend/lock/lock.ts'

// Each call waits ms before it is performed, as a provider on a slow disk would
const after = (ms: number) => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve())

// A note's version: the SHA-256 hex of its UTF-8 bytes, as the luoshu plugin keeps it
export function versionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// The luoshu in memory. read answers { text, version, path } or not-found. write refuses stale for a baseVersion that isn't
// the note's or one given for a note that doesn't exist yet. remove refuses stale for a baseVersion that isn't the
// note's, a missing one included. move never lands on a note that exists. list answers pages as the luoshu plugin
// does. It tells changed of each path it wrote, removed or moved, a move's new end naming the end it left after it
export class MemoryLuoshu implements Provider {
  readonly notes = new Map<string, string>()
  // Codes the next calls answer with, one each, for a test that needs the luoshu to fail for a while
  readonly refusals: RefusalCode[] = []
  private readonly changed: (path: string, from?: string) => Promise<void>
  private readonly latencyMs: number
  // The most names one listing answers, LIST_PAGE but in tests
  private readonly pageSize: number
  private inFlight = 0
  private peak = 0

  constructor(changed: (path: string, from?: string) => Promise<void>, latencyMs = 0, pageSize = LIST_PAGE) {
    this.changed = changed
    this.latencyMs = latencyMs
    this.pageSize = pageSize
  }

  // The most calls in flight at once since the last ask, then counting again from those in flight now
  busiest(): number {
    const peak = this.peak
    this.peak = this.inFlight
    return peak
  }

  async prepare(call: Call): Promise<Prepared | ProviderRefusal> {
    // A listing has no scope. A folder with a dot segment is refused as the luoshu refuses a name it won't serve
    if (call.action === 'luoshu.list') {
      const { folder } = call.args as { folder?: string }
      return folder !== undefined && folder.split('/').some(isDotName) ? { code: 'not-granted' } : { scope: {} }
    }
    // A move's two ends, in the order the router built its raw scope
    if (call.action === 'luoshu.move') {
      const { from, to } = call.args as { from: string, to: string }
      return { scope: { paths: [from, to] } }
    }
    const { path, baseVersion } = call.args as { path: string, baseVersion?: string }
    return baseVersion === undefined ? { scope: { paths: [path] } } : { scope: { paths: [path] }, baseVersion }
  }

  async perform(call: Call, prepared: Prepared): Promise<unknown> {
    this.inFlight++
    this.peak = Math.max(this.peak, this.inFlight)
    try {
      await after(this.latencyMs)
      return await this.performed(call, prepared)
    } finally {
      this.inFlight--
    }
  }

  private async performed(call: Call, prepared: Prepared): Promise<unknown> {
    const refusal = this.refusals.shift()
    if (refusal !== undefined) throw { code: refusal }
    if (call.action === 'luoshu.list') return this.list(call)
    const path = prepared.scope.paths![0]
    const current = this.notes.get(path)
    if (call.action === 'luoshu.read') {
      if (current === undefined) throw { code: 'not-found' }
      return { text: current, version: versionOf(current), path }
    }
    if (call.action === 'luoshu.remove') {
      if (current === undefined) throw { code: 'not-found' }
      if (prepared.baseVersion !== versionOf(current)) throw { code: 'stale' }
      this.notes.delete(path)
      await this.changed(path)
      return null
    }
    if (call.action === 'luoshu.move') {
      const to = prepared.scope.paths![1]
      if (current === undefined) throw { code: 'not-found' }
      if (this.notes.has(to)) throw { code: 'stale' }
      this.notes.set(to, current)
      this.notes.delete(path)
      await this.changed(path)
      await this.changed(to, path)
      return null
    }
    if (call.action !== 'luoshu.write') throw { code: 'not-found' }
    const base = prepared.baseVersion
    if (current === undefined ? base !== undefined : base !== versionOf(current)) throw { code: 'stale' }
    const { text } = call.args as { text: string }
    this.notes.set(path, text)
    await this.changed(path)
    return { version: versionOf(text) }
  }

  // Every note under folder at any depth, the whole luoshu with none, in code-unit order after the name given. Only
  // names the router's canList allows fill a page, so next never names one the caller can't list. A dot name is left
  // out even when canList allows it, as the luoshu's walk leaves it out. With no canList it fails
  private list(call: Call): { paths: string[], next: string | null } {
    const { canList } = call
    if (canList === undefined) throw { code: 'failed' } satisfies ProviderRefusal
    const { folder, after } = call.args as { folder?: string, after?: string }
    const kept: string[] = []
    for (const name of [...this.notes.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (folder !== undefined && !name.startsWith(`${folder}/`)) continue
      if (after !== undefined && name <= after) continue
      if (name.split('/').some(isDotName) || !canList(name)) continue
      kept.push(name)
      // One more than a page tells whether another page follows
      if (kept.length > this.pageSize) break
    }
    const paths = kept.slice(0, this.pageSize)
    return { paths, next: kept.length > this.pageSize ? paths.at(-1)! : null }
  }
}

type Kind = 'storage' | 'cache'
type Held = { value: unknown, size: number }

// What a key takes in the storage plugin's files: its JSON line, with a 64-character hash line under it in storage
function sizeOf(kind: Kind, space: string, key: string, value: unknown): number {
  return new TextEncoder().encode(`${JSON.stringify({ space, key, value })}\n`).length + (kind === 'storage' ? 65 : 0)
}

// storage.* and cache.* in memory, as the storage plugin keeps them: a space per caller and kind named by spaceOf,
// values through JSON, undefined refused and core/api's quotas held. get answers the value or null, set and delete
// answer null
export class MemoryStorage implements Provider {
  private readonly spaces: Record<Kind, Map<string, Map<string, Held>>> = { storage: new Map(), cache: new Map() }
  private readonly latencyMs: number

  constructor(latencyMs = 0) {
    this.latencyMs = latencyMs
  }

  async prepare(call: Call): Promise<Prepared | ProviderRefusal> {
    return spaceOf(call.caller) === null ? { code: 'not-granted' } : { scope: {} }
  }

  async perform(call: Call): Promise<unknown> {
    await after(this.latencyMs)
    const [kind, verb] = call.action.split('.') as [Kind, string]
    const name = spaceOf(call.caller)!
    const space = this.space(kind, name)
    const { key, value } = call.args as { key: string, value?: unknown }
    if (verb === 'get') return space.has(key) ? JSON.parse(JSON.stringify(space.get(key)!.value)) as unknown : null
    if (verb === 'delete') {
      space.delete(key)
      return null
    }
    if (value === undefined) throw { code: 'invalid' } satisfies ProviderRefusal
    const size = sizeOf(kind, name, key, value)
    let bytes = size
    let keys = 1
    for (const [other, held] of space) {
      if (other === key) continue
      bytes += held.size
      keys += 1
    }
    if (bytes > quotas[kind].bytes || keys > quotas[kind].keys) throw { code: 'failed', reason: 'quota' } satisfies ProviderRefusal
    space.set(key, { value: JSON.parse(JSON.stringify(value)) as unknown, size })
    return null
  }

  // What one space holds under key, undefined for nothing
  read(kind: Kind, space: string, key: string): unknown {
    return this.spaces[kind].get(space)?.get(key)?.value
  }

  private space(kind: Kind, name: string): Map<string, Held> {
    let space = this.spaces[kind].get(name)
    if (space === undefined) {
      space = new Map()
      this.spaces[kind].set(name, space)
    }
    return space
  }
}

// lock.* and the lock guard of the lock module itself, its table, holder, caps and expiry on the clock given and its
// lock.changed through the publish given, with the paths taken as spelled where the module makes them canonical on the
// disk. The folder it is handed is one no prepare here reads
export function memoryLock(options: LockOptions): { provider: Provider, guard: Guard } {
  const lock = createLock(options)
  lock.role.open({ folder: 'memory', dataDir: '', installDir: '' })
  return {
    provider: {
      prepare: async call => ({ scope: { paths: [...(call.args as { paths: string[] }).paths] } }),
      perform: (call, prepared) => lock.provider.perform(call, prepared),
    },
    guard: lock.guard,
  }
}

// One commit: its id, the notes it holds as path to text and the entry log answers with
type Recorded = { id: string, tree: ReadonlyMap<string, string>, entry: HistoryCommit }

// Whether a commit changed a note, anything under a folder or with null anything at all, from the one before it
function changed(now: ReadonlyMap<string, string>, before: ReadonlyMap<string, string>, target: string | null): boolean {
  return [...new Set([...now.keys(), ...before.keys()])]
    .some(path => (target === null || path === target || path.startsWith(`${target}/`)) && now.get(path) !== before.get(path))
}

// git's strict ISO date, %aI, in UTC
const isoDate = (at: Date) => at.toISOString().replace(/\.\d{3}Z$/, '+00:00')

// history.* in memory over the luoshu's notes, answering as the history module does. commit records the notes at its
// paths as one commit, a path with no note as removed, named by signatureOf as the module's are, and answers
// { commit: null } when nothing changed. log lists the commits that changed a note or anything under a folder, newest
// first. read gives a note's text at a commit or not-found. The gate judges commit and read apart, by path
export class MemoryHistory implements Provider {
  readonly notes: Map<string, string>
  private readonly commits: Recorded[] = []
  private readonly latencyMs: number

  constructor(notes: Map<string, string>, latencyMs = 0) {
    this.notes = notes
    this.latencyMs = latencyMs
  }

  async prepare(call: Call): Promise<Prepared> {
    const { path, paths } = call.args as { path?: string, paths?: string[] }
    return { scope: { paths: call.action === 'history.commit' ? [...new Set(paths)] : [path!] } }
  }

  async perform(call: Call, prepared: Prepared): Promise<unknown> {
    await after(this.latencyMs)
    const paths = prepared.scope.paths!
    if (call.action === 'history.commit') return this.commit(call, paths)
    if (call.action === 'history.log') return this.log(paths[0], (call.args as { limit?: number }).limit ?? LOG_PAGE)
    return this.read(paths[0], (call.args as { commit: string }).commit)
  }

  private commit(call: Call, paths: readonly string[]): ResultOf<'history.commit'> {
    const head = this.commits.at(-1)?.tree ?? new Map<string, string>()
    const tree = new Map(head)
    let total = 0
    for (const path of paths) {
      const text = this.notes.get(path)
      const bytes = text === undefined ? 0 : Buffer.byteLength(text)
      total += bytes
      if (bytes > HISTORY_FILE_BYTES || total > HISTORY_COMMIT_BYTES) throw { code: 'failed', reason: 'too-large' } satisfies ProviderRefusal
      if (text === undefined) tree.delete(path)
      else tree.set(path, text)
    }
    if (!changed(tree, head, null)) return { commit: null }
    const { message } = call.args as { message: string }
    const entry = { ...signatureOf(call), date: isoDate(new Date()), message: message.replace(/\n+$/, '') }
    const id = createHash('sha1').update(JSON.stringify([this.commits.length, [...tree], entry])).digest('hex')
    this.commits.push({ id, tree, entry: { commit: id, ...entry } })
    return { commit: id }
  }

  private log(target: string, limit: number): ResultOf<'history.log'> {
    const commits = this.commits
      .filter((made, at) => changed(made.tree, this.commits[at - 1]?.tree ?? new Map(), target))
      .reverse().slice(0, limit)
    return { commits: commits.map(made => ({ ...made.entry })) }
  }

  private read(target: string, id: string): ResultOf<'history.read'> {
    const text = this.commits.find(made => made.id === id)?.tree.get(target)
    if (text === undefined) throw { code: 'not-found' } satisfies ProviderRefusal
    return { text, version: versionOf(text) }
  }
}
