import { createHash, randomUUID } from 'node:crypto'
import type { PendingRequest } from '../../api/actions.ts'
import { mustType, type Change, type ChangeEffect } from '../../api/changes.ts'
import type { Caller } from '../../api/envelope.ts'
import type { Field } from '../../lib/event-log.ts'
import type { Landing } from './seams.ts'

// Requests that wait for the human at once. A fixed cap and not a floor constant, since only windows send requests
export const MAX_PENDING = 16
// How long a Confirm waits for its record to land before it applies nothing
export const CONFIRM_RECORD_MS = 10_000

// What the requests need from the loader, which owns the state
export type RequestHost = {
  effect(change: Change): ChangeEffect
  // The digest of the state files the change reads, read from disk
  fingerprint(change: Change): Promise<string>
  // Runs work with no other change applying meanwhile
  exclusive<T>(work: () => Promise<T>): Promise<T>
  // Applies a change, only from inside exclusive
  applyNow(change: Change): Promise<void>
  record(event: string, fields: Record<string, Field>, signal?: AbortSignal): Promise<Landing>
  confirmOff(): boolean
  // The human cancelled a request a plugin's call raised
  declined(plugin: string, change: Change): void
  // Writes what waits to be recorded, within ms, and gives back how many records still wait
  drain(ms: number): Promise<number>
}

export type RequestAnswer = { applied: true } | { held: string }

// raisedBy is the plugin whose call raised the request, null for one a window or the core raised
type Held = { id: string, key: string, change: Change, fingerprint: Promise<string>, window: string, raisedBy: string | null }

// The same text for a change whatever order its fields came in, so a change asked twice is found again and its hash
// in the records doesn't depend on how a window spelled it
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// What the records say of a change: its kind, its target and the hash of the change as stored. Never a folder or a
// scope, which the hash stands for
function fieldsOf(change: Change, key: string): Record<string, Field> {
  const target = 'plugin' in change ? change.plugin : change.kind === 'allowUnsigned' ? change.hash : null
  return {
    kind: change.kind,
    target: change.kind === 'limit.set' ? `${change.constant}:${change.plugin ?? 'all'}` : target,
    hash: createHash('sha256').update(key).digest('hex'),
  }
}

const windowOf = (from: Caller) => (from.kind === 'window' ? from.role : from.kind)

// Security requests: a narrowing change applies at once with its record. A widening or destroying one waits under a
// core id with the fingerprint of the state it read, until the trusted window's Confirm or Cancel. The Confirm record
// lands first, so a widening never applies without it (decision 4)
export class Requests {
  private readonly held = new Map<string, Held>()
  private readonly host: RequestHost

  constructor(host: RequestHost) {
    this.host = host
  }

  // Oldest first, the order the trusted window shows them in
  pending(): PendingRequest[] {
    return [...this.held.values()].map(({ id, change }) => ({ id, kind: change.kind, plugin: 'plugin' in change ? change.plugin : null }))
  }

  async request(change: Change, from: Caller): Promise<RequestAnswer> {
    const key = canonical(change)
    const fields = { ...fieldsOf(change, key), window: windowOf(from) }
    const effect = this.host.effect(change)
    if (effect === 'narrows') {
      await this.host.exclusive(() => this.host.applyNow(change))
      void this.host.record('security.applied', { ...fields, by: 'narrows' })
      return { applied: true }
    }
    // The human's second deliberate step: changes the trusted window itself asks for skip the Confirm (decision 18).
    // The record still lands before anything widens
    if (from.kind === 'window' && from.role === 'trusted' && this.host.confirmOff()) {
      await this.host.exclusive(() => this.landThenApply(change, { ...fields, by: 'confirm-off' }))
      return { applied: true }
    }
    const held = this.hold(change, key, fields, null, MAX_PENDING)
    if (typeof held !== 'string') throw held
    // Answered once the state it read is fingerprinted, so an edit made after the answer counts as a change
    await this.held.get(held)?.fingerprint
    return { held }
  }

  // A request a plugin's call or the core raised: never applied at once, since nobody clicked anything. A plugin may
  // hold open requests up to its limit, the same change asked again finds its id
  raise(change: Change, raisedBy: string | null, limit: number): string | { code: 'throttled' } {
    const key = canonical(change)
    return this.hold(change, key, { ...fieldsOf(change, key), window: raisedBy === null ? 'core' : 'plugin' }, raisedBy, limit)
  }

  private hold(change: Change, key: string, fields: Record<string, Field>, raisedBy: string | null, limit: number): string | { code: 'throttled' } {
    for (const one of this.held.values()) if (one.key === key) return one.id
    const open = raisedBy === null ? this.held.size : [...this.held.values()].filter(one => one.raisedBy === raisedBy).length
    if (open >= limit || this.held.size >= MAX_PENDING) return { code: 'throttled' }
    const id = randomUUID()
    const fingerprint = this.host.fingerprint(change).catch(() => 'unreadable')
    this.held.set(id, { id, key, change, fingerprint, window: fields.window as string, raisedBy })
    void this.host.record('security.request', fields)
    return id
  }

  // Only the trusted window's Confirm reaches here, which the carrier checks first. A change that asks for typing
  // needs the word typed exactly. One whose state moved since the request is dropped as stale
  confirm(id: string, options: { typed?: string }): Promise<void> {
    return this.host.exclusive(async () => {
      const one = this.held.get(id)
      if (one === undefined) throw { code: 'not-found' }
      const word = mustType(one.change)
      if (word !== null && options.typed !== word) throw { code: 'invalid' }
      const fields = { ...fieldsOf(one.change, one.key), window: 'trusted' }
      if (await this.host.fingerprint(one.change) !== await one.fingerprint) {
        this.held.delete(id)
        void this.host.record('security.stale', fields)
        throw { code: 'stale' }
      }
      await this.landThenApply(one.change, { ...fields, by: 'confirm' })
      this.held.delete(id)
    })
  }

  async cancel(id: string): Promise<void> {
    const one = this.held.get(id)
    if (one === undefined) throw { code: 'not-found' }
    this.held.delete(id)
    void this.host.record('security.cancel', { ...fieldsOf(one.change, one.key), window: 'trusted' })
    if (one.raisedBy !== null) this.host.declined(one.raisedBy, one.change)
  }

  // The Confirm record on disk, or muted with recording off, then the change. A record that doesn't land in time
  // applies nothing, and a write that fails applies nothing either
  private async landThenApply(change: Change, fields: Record<string, Field>): Promise<void> {
    // Turning recording off writes what waits first and counts what still does in its own record, which is then the
    // last one written (S4-5)
    if (change.kind === 'recordNothing' && change.on) fields = { ...fields, unwritten: await this.host.drain(CONFIRM_RECORD_MS) }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), CONFIRM_RECORD_MS)
    let landing: Landing
    try {
      landing = await this.host.record('security.confirm', fields, abort.signal)
    } finally {
      clearTimeout(timer)
    }
    if (landing === 'lost') throw { code: 'failed' }
    try {
      await this.host.applyNow(change)
    } catch {
      void this.host.record('security.failed', fields)
      throw { code: 'failed' }
    }
    void this.host.record('security.applied', fields)
  }
}
