import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { quotas as fixedQuotas, spaceOf } from 'hetu-core/api/storage.ts'
import type { Call, Prepared, Provider, ProviderRefusal } from 'hetu-core/api/slots.ts'
import { retried } from 'hetu-core/lib/disk.ts'
import { checkHash, replaceFile, withHash } from 'hetu-core/lib/hashed-file.ts'

type Kind = 'storage' | 'cache'
type Quota = { readonly bytes: number, readonly keys: number }
export type Quotas = { readonly storage: Quota, readonly cache: Quota }

// The key grammar core/api's localName holds every call to, checked again here since the file name is built from it
const keyName = /^[a-z][a-zA-Z0-9]{0,63}$/
// A key's file. Anything else in a space, a temp file a crash left included, is no key and isn't counted
const keyFile = /^key-[a-z0-9_]+$/

// key- then the key with each capital written as _ and the letter. Windows and macOS compare names without case, so
// myKey and mykey would be one file. No Windows device name starts with key-, and the names hold no ~, which every 8.3
// alias does, so a key can't open another key's file through one
export function fileOf(key: string): string {
  return `key-${key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`
}

const refused = (code: ProviderRefusal['code'], reason?: ProviderRefusal['reason']): ProviderRefusal =>
  (reason === undefined ? { code } : { code, reason })

export type Storage = Provider & {
  readonly quotas: Quotas
  // The data folder the loader hands an install host half. Calls before it answer unavailable
  open(dataDir: string): void
  // Removes a space in its turn, after every call already queued on it, for the loader's clears
  clear(kind: Kind, space: string): Promise<void>
}

// storage.* and cache.* for every caller, each in the space spaceOf names under storage/ and cache/. A stored key is one
// JSON line naming the key, then its hash line. The cache has no hash line and is rebuildable. Calls on one space run
// one at a time, so a set counted against the quota can't race another. Spaces don't wait on each other
export function createStorage(options: { quotas?: Quotas } = {}): Storage {
  const quotas = options.quotas ?? fixedQuotas
  let dataDir: string | null = null
  const queues = new Map<string, Promise<void>>()
  const swept = new Set<string>()

  function inOrder<T>(name: string, work: () => Promise<T>): Promise<T> {
    const done = (queues.get(name) ?? Promise.resolve()).then(work)
    const tail = done.then(() => {}, () => {})
    queues.set(name, tail)
    void tail.then(() => {
      if (queues.get(name) === tail) queues.delete(name)
    })
    return done
  }

  // Temp files a crash left mid-write go the first time a space is touched in a run, inside its queue, so no write of
  // this run is under way
  async function sweep(dir: string): Promise<void> {
    if (swept.has(dir)) return
    for (const name of await names(dir)) {
      if (name.endsWith('.tmp')) await retried(() => rm(path.join(dir, name), { force: true }))
    }
    swept.add(dir)
  }

  // What the space holds apart from the key being set, read from disk each time, so a space the loader cleared while
  // its plugin was stopped never leaves a stale count
  async function withinQuota(dir: string, own: string, size: number, quota: Quota): Promise<void> {
    let bytes = size
    let keys = 1
    for (const name of await names(dir)) {
      if (name === own || !keyFile.test(name)) continue
      const info = await stat(path.join(dir, name)).catch(() => null)
      if (info === null || !info.isFile()) continue
      bytes += info.size
      keys += 1
    }
    if (bytes > quota.bytes || keys > quota.keys) throw refused('failed', 'quota')
  }

  async function get(kind: Kind, file: string, space: string, key: string): Promise<unknown> {
    let bytes: Buffer
    try {
      bytes = await retried(() => readFile(file), file, 'read')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    if (kind === 'cache') return entryOf(bytes, space, key) ?? null
    const checked = checkHash(bytes)
    const entry = 'body' in checked ? entryOf(checked.body, space, key) : undefined
    if (entry === undefined) throw refused('tampered')
    return entry
  }

  return {
    quotas,

    open(dir: string): void {
      dataDir = dir
    },

    clear(kind: Kind, space: string): Promise<void> {
      if (dataDir === null) return Promise.resolve()
      const dir = path.join(dataDir, kind, space)
      return inOrder(`${kind}/${space}`, async () => {
        await retried(() => rm(dir, { recursive: true, force: true }))
        swept.delete(dir)
      })
    },

    async prepare(call: Call): Promise<Prepared | ProviderRefusal> {
      return spaceOf(call.caller) === null ? refused('not-granted') : { scope: {} }
    },

    async perform(call: Call): Promise<unknown> {
      const root = dataDir
      const space = spaceOf(call.caller)
      if (root === null) throw refused('unavailable')
      if (space === null) throw refused('not-granted')
      const [kind, verb] = call.action.split('.') as [Kind, 'get' | 'set' | 'delete']
      if ((kind !== 'storage' && kind !== 'cache') || !['get', 'set', 'delete'].includes(verb)) throw refused('invalid')
      const { key, value } = (call.args ?? {}) as { key?: unknown, value?: unknown }
      if (typeof key !== 'string' || !keyName.test(key)) throw refused('invalid')
      if (verb === 'set' && value === undefined) throw refused('invalid')
      const dir = path.join(root, kind, space)
      const name = fileOf(key)
      const file = path.join(dir, name)
      return inOrder(`${kind}/${space}`, async () => {
        await sweep(dir)
        if (verb === 'get') return get(kind, file, space, key)
        if (verb === 'delete') {
          await retried(() => rm(file, { force: true }))
          return null
        }
        const line = Buffer.from(`${JSON.stringify({ space, key, value })}\n`)
        const bytes = kind === 'storage' ? withHash(line) : line
        await withinQuota(dir, name, bytes.length, quotas[kind])
        await mkdir(dir, { recursive: true })
        await replaceFile(file, bytes)
        return null
      })
    },
  }
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

// The value a key's line holds, or undefined for bytes that aren't one JSON object of exactly the space, the key and a
// value, naming this space and key. The hash line catches an edit that doesn't recompute it, and naming both catches a
// file copied from another key or space. A local program that recomputes it is out of scope (threat 43)
function entryOf(bytes: Buffer, space: string, key: string): unknown {
  let entry: unknown
  try {
    entry = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    return undefined
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const fields = Object.keys(entry)
  if (fields.length !== 3 || !['space', 'key', 'value'].every(name => fields.includes(name))) return undefined
  const { space: inSpace, key: named, value } = entry as { space: unknown, key: unknown, value: unknown }
  return inSpace === space && named === key ? value : undefined
}
