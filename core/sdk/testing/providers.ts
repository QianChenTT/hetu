import { createHash } from 'node:crypto'
import type { RefusalCode } from '../../api/envelope.ts'
import type { Call, Prepared, Provider } from '../../api/slots.ts'

// Each call waits ms before it is performed, as a provider on a slow disk would
const after = (ms: number) => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve())

// A note's version: the SHA-256 hex of its UTF-8 bytes, as the vault plugin keeps it
export function versionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// The vault in memory. read answers { text, version } or not-found. write refuses stale for a baseVersion that isn't
// the note's or one given for a note that doesn't exist yet. It tells changed of each path it wrote
export class MemoryVault implements Provider {
  readonly notes = new Map<string, string>()
  // Codes the next calls answer with, one each, for a test that needs the vault to fail for a while
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
    if (call.action === 'vault.read') {
      if (current === undefined) throw { code: 'not-found' }
      return { text: current, version: versionOf(current) }
    }
    if (call.action !== 'vault.write') throw { code: 'not-found' }
    const base = prepared.baseVersion
    if (current === undefined ? base !== undefined : base !== versionOf(current)) throw { code: 'stale' }
    const { text } = call.args as { text: string }
    this.notes.set(path, text)
    await this.changed(path)
    return { version: versionOf(text) }
  }
}

type Kind = 'storage' | 'cache'

// storage.* and cache.* in memory, one space per caller and kind, keyed by the caller the carrier names. get answers
// the value or null, set and delete answer null
export class MemoryStorage implements Provider {
  private readonly spaces: Record<Kind, Map<string, Map<string, unknown>>> = { storage: new Map(), cache: new Map() }
  private readonly latencyMs: number

  constructor(latencyMs = 0) {
    this.latencyMs = latencyMs
  }

  async prepare(): Promise<Prepared> {
    return { scope: {} }
  }

  async perform(call: Call): Promise<unknown> {
    await after(this.latencyMs)
    const [kind, verb] = call.action.split('.') as [Kind, string]
    const space = this.space(kind, ownerOf(call))
    const { key, value } = call.args as { key: string, value?: unknown }
    if (verb === 'get') return space.has(key) ? space.get(key) : null
    if (verb === 'set') space.set(key, structuredClone(value))
    else space.delete(key)
    return null
  }

  // What one caller stored under key, undefined for nothing
  read(kind: Kind, owner: string, key: string): unknown {
    return this.spaces[kind].get(owner)?.get(key)
  }

  private space(kind: Kind, owner: string): Map<string, unknown> {
    let space = this.spaces[kind].get(owner)
    if (space === undefined) {
      space = new Map()
      this.spaces[kind].set(owner, space)
    }
    return space
  }
}

function ownerOf(call: Call): string {
  const { caller } = call
  if (caller.kind === 'plugin') return caller.id
  return caller.kind === 'window' ? `window:${caller.role}` : `content:${caller.plugin}`
}
