import { createHash, randomUUID } from 'node:crypto'
import type { PendingRequest } from '../../api/actions.ts'
import { lapseOf, type Change, type ChangeEffect } from '../../api/changes.ts'
import { isSecurityControl } from '../../api/ids.ts'
import type { Caller } from '../../api/envelope.ts'
import type { Field } from '../../lib/event-log.ts'
import type { Asked, Confirmed, InLine, SecurityView } from '../security-view/header.ts'
import type { Landing, PluginsRecording } from './header.ts'

// Requests that wait for the human at once from one sender: each window role and the core. A plugin's own asks wait
// within its firstUseAsks. A fixed cap and not a limit, so one window can't fill the places the trusted window
// and the core need
export const MAX_PENDING = 16
// Every request waiting at once, whoever sent it
const MAX_HELD = 4 * MAX_PENDING
// How long a Confirm waits for its record to land before it applies nothing
export const CONFIRM_RECORD_MS = 10_000

// What the requests need from the plugins manager, which owns the state
export type RequestHost = {
  effect(change: Change): ChangeEffect
  // The digest of the state files the change reads, read from disk
  fingerprint(change: Change): Promise<string>
  // Runs work with no other change applying meanwhile
  exclusive<T>(work: () => Promise<T>): Promise<T>
  // Applies a change, only from inside exclusive. confirmed is whether the human clicked its Confirm. unchanged says the
  // change found nothing to change, which a narrowing records nothing for
  applyNow(change: Change, confirmed: boolean): Promise<void | 'unchanged'>
  record(event: string, fields: Record<string, Field>, signal?: AbortSignal): Promise<Landing>
  // The security view while the human has it on, which decides whether a change waits and whether a Confirm counts,
  // and where a throw of it is recorded
  view(): SecurityView | null
  fault(step: string): void
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
  // Recording, which drains what waits to be recorded within ms and gives back how many records still wait, then
  // writes nothing until recording is off or resume is called
  recording: Pick<PluginsRecording, 'drain' | 'resume'>
}

export type RequestAnswer = { applied: true } | { held: string }

// raisedBy is the plugin whose call raised the request, null for one a window or the core raised. until is the clock
// time it lapses at, null for one that waits until answered
type Held = {
  id: string, key: string, change: Change, fingerprint: Promise<string>, window: string, raisedBy: string | null, source: string, until: number | null
}

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
// scope, which the hash stands for. An agent's ask and its revoke name the agent, whose label's form holds ASCII alone
function fieldsOf(change: Change, key: string): Record<string, Field> {
  const agent = change.kind === 'agent.ask' || change.kind === 'agent.revoke' ? change.agent : null
  const target = agent ?? ('plugin' in change ? change.plugin : change.kind === 'allowUnsigned' ? change.hash : null)
  return {
    kind: change.kind,
    target: change.kind === 'limit.set' ? `${change.constant}:${change.plugin ?? 'all'}` : target,
    hash: createHash('sha256').update(key).digest('hex'),
  }
}

const windowOf = (from: Caller) => (from.kind === 'window' ? from.role : from.kind)

// A security control switched off, which waits for the security view's typed word
const controlOff = (change: Change) => change.kind === 'plugin.off' && isSecurityControl(change.plugin)

// Security requests: the security view decides whether a change applies at once with its record, lands its record and
// applies or waits under a core id with the fingerprint of the state it read, until the trusted window's Confirm or
// Cancel. The Confirm record lands first, so a widening never applies without it. With the view off every change a
// window asks for applies unasked with its record first, while the editor window may only switch the view on again
export class Requests {
  private readonly held = new Map<string, Held>()
  private readonly host: RequestHost
  // The request first in line, which the trusted window draws, and since when
  private head: { id: string, at: number } | null = null

  constructor(host: RequestHost) {
    this.host = host
  }

  // The word the security view asks for before a request's Confirm counts, none while it is off or when it throws
  typed(change: Change): string | null {
    try {
      return this.host.view()?.mustType(change) ?? null
    } catch {
      this.host.fault('mustType')
      return null
    }
  }

  // Each request with its change, oldest first
  changes(): { id: string, change: Change }[] {
    this.lapse()
    return [...this.held.values()].map(({ id, change }) => ({ id, change }))
  }

  // Oldest first, the order the trusted window shows them in
  pending(): PendingRequest[] {
    this.lapse()
    return [...this.held.values()].map(({ id, change }) => ({ id, kind: change.kind, plugin: 'plugin' in change ? change.plugin : null }))
  }

  async request(change: Change, from: Caller): Promise<RequestAnswer> {
    const key = canonical(change)
    const fields = { ...fieldsOf(change, key), window: windowOf(from) }
    const asked = this.asked(change, from)
    if (asked === 'apply') {
      const applied = await this.host.exclusive(() => this.host.applyNow(change, false))
      if (applied !== 'unchanged') void this.host.record('security.applied', { ...fields, by: 'narrows' })
      return { applied: true }
    }
    // The record still lands before anything widens
    if (asked !== 'hold') {
      await this.host.exclusive(() => this.landThenApply(change, { ...fields, by: asked === 'land' ? 'confirm-off' : 'view-off' }))
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
    this.lapse()
    // The same change asked again finds the request and leaves its lapse where it was
    for (const one of this.held.values()) if (one.key === key) return one.id
    const open = [...this.held.values()].filter(one => one.source === source).length
    if (open >= limit || this.held.size >= MAX_HELD) return { code: 'throttled' }
    const id = randomUUID()
    const fingerprint = this.host.fingerprint(change).catch(() => 'unreadable')
    const lapse = lapseOf(change)
    const until = lapse === null ? null : this.host.clock() + lapse
    this.held.set(id, { id, key, change, fingerprint, window: fields.window as string, raisedBy, source, until })
    // So windows hear of it at the lapse though nothing reads the list then
    if (lapse !== null) setTimeout(() => this.lapse(), lapse).unref?.()
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

  // Drops each request whose time ran out, with its record. A lapsed request can't be confirmed
  private lapse(): void {
    const now = this.host.clock()
    for (const one of [...this.held.values()]) {
      if (one.until === null || now < one.until) continue
      this.drop(one.id)
      void this.host.record('security.lapsed', { ...fieldsOf(one.change, one.key), window: one.window })
    }
  }

  private drop(id: string): void {
    this.held.delete(id)
    this.moved()
  }

  // Only the trusted window's Confirm reaches here, which the router checks first. The security view says whether the
  // click counts, from how long the request has been first in line and what was typed. One whose state moved since the
  // request is dropped as stale
  confirm(id: string, options: { typed?: string }): Promise<void> {
    return this.host.exclusive(async () => {
      this.lapse()
      const one = this.held.get(id)
      if (one === undefined) throw { code: 'not-found' }
      const head = this.head
      const inLine: InLine = head === null || head.id !== id ? null : { waited: this.host.clock() - head.at, delayMs: this.host.delayMs }
      const confirmed = this.confirmed(one.change, inLine, options.typed)
      // A control's off waits for the view to be on again, where its word is asked
      if (confirmed === 'locked') throw { code: 'not-granted' }
      if (confirmed !== 'ok') throw { code: confirmed }
      const fields = { ...fieldsOf(one.change, one.key), window: 'trusted' }
      if (await this.host.fingerprint(one.change) !== await one.fingerprint) {
        this.drop(id)
        void this.host.record('security.stale', fields)
        throw { code: 'stale' }
      }
      // Looked up again once the record landed: a request withdrawn or lapsed while it landed applies nothing
      const still = () => {
        this.lapse()
        return this.held.get(id) === one
      }
      await this.landThenApply(one.change, { ...fields, by: 'confirm' }, still)
      this.drop(id)
    })
  }

  // The security view's word on a change a window asked for. Off, no security control goes off, a narrowing change
  // applies at once and every other one unasked, while the editor window may send only the change that switches the view
  // on again. A throw, or a word outside the list, applies nothing
  private asked(change: Change, from: Caller): Asked | 'unasked' {
    const effect = this.host.effect(change)
    const view = this.host.view()
    if (view === null) {
      const editor = from.kind === 'window' && from.role === 'editor'
      if (editor && !(change.kind === 'plugin.on' && change.plugin === 'security-view')) throw { code: 'not-granted' }
      if (controlOff(change)) throw { code: 'not-granted' }
      return effect === 'narrows' ? 'apply' : 'unasked'
    }
    let asked: unknown
    try {
      asked = view.asked(change, effect, from, this.host.confirmOff())
    } catch {}
    if (asked === 'apply' || asked === 'land' || asked === 'hold') return asked
    this.host.fault('asked')
    throw { code: 'failed' }
  }

  // Whether a Confirm counts, at once while the view is off unless it switches a security control off, which nothing
  // can while no word is asked. A throw, or a word outside the list, counts nothing
  private confirmed(change: Change, inLine: InLine, typed: string | undefined): Confirmed | 'failed' | 'locked' {
    const view = this.host.view()
    if (view === null) return controlOff(change) ? 'locked' : 'ok'
    let confirmed: unknown
    try {
      confirmed = view.confirms(change, inLine, typed)
    } catch {}
    if (confirmed === 'ok' || confirmed === 'throttled' || confirmed === 'invalid') return confirmed
    this.host.fault('confirms')
    return 'failed'
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
      this.lapse()
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
  // record share the one wait. still says whether the request is still held once its record landed, for a Confirm
  private async landThenApply(change: Change, fields: Record<string, Field>, still: () => boolean = () => true): Promise<void> {
    const stopping = change.kind === 'plugin.off' && change.plugin === 'recording'
    const whole = this.host.recordMs ?? CONFIRM_RECORD_MS
    const wait = stopping ? whole / 2 : whole
    // A drain that throws leaves how much still waits unknown, and the switch goes on all the same
    if (stopping) fields = { ...fields, unwritten: await Promise.resolve().then(() => this.host.recording.drain(wait)).catch(() => null) }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), wait)
    let landing: Landing
    try {
      landing = await this.host.record('security.confirm', fields, abort.signal)
    } finally {
      clearTimeout(timer)
    }
    if (landing === 'lost' && !stopping) throw { code: 'failed' }
    if (!still()) {
      if (stopping) this.host.recording.resume()
      throw { code: 'not-found' }
    }
    try {
      await this.host.applyNow(change, fields.by === 'confirm')
    } catch {
      if (stopping) this.host.recording.resume()
      void this.host.record('security.failed', fields)
      throw { code: 'failed' }
    }
    void this.host.record('security.applied', fields)
  }
}
