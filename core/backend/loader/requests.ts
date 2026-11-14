import { createHash, randomUUID } from 'node:crypto'
import type { PendingRequest } from '../../api/actions.ts'
import { mustType, type Change, type ChangeEffect } from '../../api/changes.ts'
import type { Caller } from '../../api/envelope.ts'
import type { Field } from '../../lib/event-log.ts'
import type { Landing } from './seams.ts'

// Requests that wait for the human at once from one sender: each window role and the core. A plugin's own asks wait
// within its firstUseAsks. A fixed cap and not a floor constant, so one window can't fill the places the trusted window
// and the core need
export const MAX_PENDING = 16
// Every request waiting at once, whoever sent it
const MAX_HELD = 4 * MAX_PENDING
// How long a Confirm waits for its record to land before it applies nothing
export const CONFIRM_RECORD_MS = 10_000

// What the requests need from the loader, which owns the state
export type RequestHost = {
  effect(change: Change): ChangeEffect
  // The digest of the state files the change reads, read from disk
  fingerprint(change: Change): Promise<string>
  // Runs work with no other change applying meanwhile
  exclusive<T>(work: () => Promise<T>): Promise<T>
  // Applies a change, only from inside exclusive. confirmed is whether the human clicked its Confirm
  applyNow(change: Change, confirmed: boolean): Promise<void>
  record(event: string, fields: Record<string, Field>, signal?: AbortSignal): Promise<Landing>
  confirmOff(): boolean
  // The human cancelled a request a plugin's call raised
  declined(plugin: string, change: Change): void
  // The human cancelled any request, after it went
  cancelled?(change: Change): Promise<void>
  // A request was raised or went, so windows read core.status again
  changed(): void
  // A clock no change of the wall clock moves, and how long a request must be first in line before its Confirm counts
  clock(): number
  delayMs: number
  // How long a Confirm waits for its record to land, CONFIRM_RECORD_MS unless a test names another
  recordMs?: number
  // Writes what waits to be recorded, within ms, and gives back how many records still wait. The audit writer then
  // writes nothing until recording is off or resume is called
  drain(ms: number): Promise<number>
  resume(): void
}

export type RequestAnswer = { applied: true } | { held: string }

// raisedBy is the plugin whose call raised the request, null for one a window or the core raised
type Held = { id: string, key: string, change: Change, fingerprint: Promise<string>, window: string, raisedBy: string | null, source: string }

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
// lands first, so a widening never applies without it
export class Requests {
  private readonly held = new Map<string, Held>()
  private readonly host: RequestHost
  // The request first in line, which the trusted window draws, and since when
  private head: { id: string, at: number } | null = null

  constructor(host: RequestHost) {
    this.host = host
  }

  // Each request with its change, oldest first
  changes(): { id: string, change: Change }[] {
    return [...this.held.values()].map(({ id, change }) => ({ id, change }))
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
      await this.host.exclusive(() => this.host.applyNow(change, false))
      void this.host.record('security.applied', { ...fields, by: 'narrows' })
      return { applied: true }
    }
    // The human's second deliberate step: changes the trusted window itself asks for skip the Confirm.
    // The record still lands before anything widens. A change that asks for typing still waits for it, since the
    // switch skips the click and not the proof of attention that switching protection off asks for
    if (from.kind === 'window' && from.role === 'trusted' && this.host.confirmOff() && mustType(change) === null) {
      await this.host.exclusive(() => this.landThenApply(change, { ...fields, by: 'confirm-off' }))
      return { applied: true }
    }
    const held = this.hold(change, key, fields, null, MAX_PENDING, fields.window as string)
    if (typeof held !== 'string') throw held
    // Answered once the state it read is fingerprinted, so an edit made after the answer counts as a change
    await this.held.get(held)?.fingerprint
    return { held }
  }

  // A request a plugin's call or the core raised: never applied at once, since nobody clicked anything. A plugin may
  // hold open requests up to its limit, the same change asked again finds its id. source names whose places it takes,
  // the plugin or the core unless one is named
  raise(change: Change, raisedBy: string | null, limit: number, source?: string): string | { code: 'throttled' } {
    const key = canonical(change)
    const window = raisedBy === null ? 'core' : 'plugin'
    return this.hold(change, key, { ...fieldsOf(change, key), window }, raisedBy, limit, source ?? raisedBy ?? 'core')
  }

  // source names whose places the request takes: a window role, the core or the plugin that raised it
  private hold(
    change: Change, key: string, fields: Record<string, Field>, raisedBy: string | null, limit: number, source: string,
  ): string | { code: 'throttled' } {
    for (const one of this.held.values()) if (one.key === key) return one.id
    const open = [...this.held.values()].filter(one => one.source === source).length
    if (open >= limit || this.held.size >= MAX_HELD) return { code: 'throttled' }
    const id = randomUUID()
    const fingerprint = this.host.fingerprint(change).catch(() => 'unreadable')
    this.held.set(id, { id, key, change, fingerprint, window: fields.window as string, raisedBy, source })
    void this.host.record('security.request', fields)
    this.moved()
    return id
  }

  // The list changed: the request first in line starts its delay when it becomes first, and windows hear of it
  private moved(): void {
    const first = this.held.keys().next()
    const id = first.done === true ? null : first.value
    if (id === null) this.head = null
    else if (this.head?.id !== id) this.head = { id, at: this.host.clock() }
    try {
      this.host.changed()
    } catch {}
  }

  private drop(id: string): void {
    this.held.delete(id)
    this.moved()
  }

  // Only the trusted window's Confirm reaches here, which the carrier checks first. Only the request first in line counts,
  // once it has been first for the delay, so a click aimed at the request before can't land on the next one drawn in its
  // place. A change that asks for typing needs the word typed exactly. One whose state moved since the request is
  // dropped as stale
  confirm(id: string, options: { typed?: string }): Promise<void> {
    return this.host.exclusive(async () => {
      const one = this.held.get(id)
      if (one === undefined) throw { code: 'not-found' }
      const head = this.head
      if (head === null || head.id !== id || this.host.clock() - head.at < this.host.delayMs) throw { code: 'throttled' }
      const word = mustType(one.change)
      if (word !== null && options.typed !== word) throw { code: 'invalid' }
      const fields = { ...fieldsOf(one.change, one.key), window: 'trusted' }
      if (await this.host.fingerprint(one.change) !== await one.fingerprint) {
        this.drop(id)
        void this.host.record('security.stale', fields)
        throw { code: 'stale' }
      }
      await this.landThenApply(one.change, { ...fields, by: 'confirm' })
      this.drop(id)
    })
  }

  // Drops the requests a change made pointless, such as an update a newer one replaced, so none can be confirmed for
  // something the human no longer sees
  withdraw(match: (change: Change) => boolean): void {
    for (const one of [...this.held.values()]) {
      if (!match(one.change)) continue
      this.drop(one.id)
      void this.host.record('security.withdrawn', { ...fieldsOf(one.change, one.key), window: one.window })
    }
  }

  // In the same queue as a Confirm, so a Cancel made while a Confirm waits on its record waits for it and then finds
  // nothing to cancel
  cancel(id: string): Promise<void> {
    return this.host.exclusive(async () => {
      const one = this.held.get(id)
      if (one === undefined) throw { code: 'not-found' }
      this.drop(id)
      void this.host.record('security.cancel', { ...fieldsOf(one.change, one.key), window: 'trusted' })
      if (one.raisedBy !== null) this.host.declined(one.raisedBy, one.change)
      await this.host.cancelled?.(one.change)
    })
  }

  // The Confirm record on disk, or muted with recording off, then the change. A record that doesn't land in time
  // applies nothing, and a write that fails applies nothing either. Turning recording off is the one exception: it
  // writes what waits first and counts what still does in its own record, which is then the last one written,
  // and it applies even when that record is lost, since the log it switches off is what can't write. The drain and the
  // record share the one wait
  private async landThenApply(change: Change, fields: Record<string, Field>): Promise<void> {
    const stopping = change.kind === 'recordNothing' && change.on
    const whole = this.host.recordMs ?? CONFIRM_RECORD_MS
    const wait = stopping ? whole / 2 : whole
    if (stopping) fields = { ...fields, unwritten: await this.host.drain(wait) }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), wait)
    let landing: Landing
    try {
      landing = await this.host.record('security.confirm', fields, abort.signal)
    } finally {
      clearTimeout(timer)
    }
    if (landing === 'lost' && !stopping) throw { code: 'failed' }
    try {
      await this.host.applyNow(change, fields.by === 'confirm')
    } catch {
      if (stopping) this.host.resume()
      void this.host.record('security.failed', fields)
      throw { code: 'failed' }
    }
    void this.host.record('security.applied', fields)
  }
}
