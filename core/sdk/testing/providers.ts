import { createHash } from 'node:crypto'
import type { RefusalCode } from '../../api/envelope.ts'
import type { Call, Prepared, Provider, ProviderRefusal } from '../../api/slots.ts'
import { quotas, spaceOf } from '../../api/storage.ts'

// Each call waits ms before it is performed, as a provider on a slow disk would
const after = (ms: number) => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve())

// A note's version: the SHA-256 hex of its UTF-8 bytes, as the luoshu plugin keeps it
export function versionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// The luoshu in memory. read answers { text, version } or not-found. write refuses stale for a baseVersion that isn't
// the note's or one given for a note that doesn't exist yet. remove refuses stale for a baseVersion that isn't the
// note's, a missing one included. move never lands on a note that exists. It tells changed of each path it wrote, removed or moved
export class MemoryLuoshu implements Provider {
  readonly notes = new Map<string, string>()
  // Codes the next calls answer with, one each, for a test that needs the luoshu to fail for a while
  readonly refusals: RefusalCode[] = []
  private readonly changed: (path: string) => Promise<void>
  private readonly latencyMs: number
  private inFlight = 0
  private peak = 0

  constructor(changed: (path: string) => Promise<void>, latencyMs = 0) {
    this.changed = changed
    this.latencyMs = latencyMs
  }

  // The most calls in flight at once since the last ask, then counting again from those in flight now
  busiest(): number {
    const peak = this.peak
    this.peak = this.inFlight
    return peak
  }

  async prepare(call: Call): Promise<Prepared> {
    // A move's two ends, in the order the carrier built its raw scope
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
    const path = prepared.scope.paths![0]
    const current = this.notes.get(path)
    if (call.action === 'luoshu.read') {
      if (current === undefined) throw { code: 'not-found' }
      return { text: current, version: versionOf(current) }
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
      await this.changed(to)
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
