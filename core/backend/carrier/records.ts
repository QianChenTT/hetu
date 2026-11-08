import type { Caller } from '../../api/envelope.ts'
import type { AuditRecord } from '../../api/slots.ts'
import type { Field } from '../../lib/event-log.ts'
import type { FloorLog, Landing } from './seams.ts'

// landed settles the promise its write gave back. floor.dropped, which the lane writes itself, has none. writing is
// set while its append is under way, when it can no longer be taken out. withdrawn is a waiter that gave up meanwhile,
// so the record comes out if that append fails. done drops the listener on the waiter's signal
type FloorRecord = {
  event: string, fields: Record<string, Field>, landed?: (landing: Landing) => void, writing?: boolean, withdrawn?: boolean,
  done?: () => void,
}

// Floor records go straight through the one EventLog in the order they were made, ahead of the audit queue and with
// the log plugin off. While the log can't write they wait in a bounded backlog. One past the bound is dropped and
// counted and the count lands as floor.dropped once the backlog has. A write never blocks and never throws. Nothing is
// taken in while the human turned recording off. Each write gives back a promise that never rejects and settles once
// the record's fate is known, for the loader, which applies some changes only once their record is on disk. A waiter
// that gives up aborts its signal: a record still waiting then comes out and settles lost, so the log never shows a
// change that didn't apply. One whose append is under way can't be called back: it lands if that append works and comes out if it fails
export class FloorLane {
  private readonly log: FloorLog | null
  private readonly bound: () => number
  private readonly muted: () => boolean
  private readonly retryMs: number
  private readonly backlog: FloorRecord[] = []
  private overflowed = 0
  private pumping = false
  private current: Promise<void> = Promise.resolve()
  private retry: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(log: FloorLog | null, options: { bound: () => number, muted: () => boolean, retryMs: number }) {
    this.log = log
    this.bound = options.bound
    this.muted = options.muted
    this.retryMs = options.retryMs
  }

  // Records waiting for the log and records dropped since the backlog last emptied
  get waiting(): number {
    return this.backlog.length
  }

  get dropped(): number {
    return this.overflowed
  }

  // Whether a record written now is taken in
  get recording(): boolean {
    return !this.closed && !this.muted()
  }

  write(event: string, fields: Record<string, Field> = {}, signal?: AbortSignal): Promise<Landing> {
    if (this.closed) return Promise.resolve('lost')
    if (this.muted()) return Promise.resolve('muted')
    if (signal?.aborted) return Promise.resolve('lost')
    if (this.backlog.length >= this.bound()) {
      this.overflowed++
      return Promise.resolve('lost')
    }
    return new Promise(settle => {
      const record: FloorRecord = { event, fields: { ...fields } }
      const withdraw = () => {
        const at = this.backlog.indexOf(record)
        if (at === -1) return
        if (record.writing) {
          record.withdrawn = true
          return
        }
        this.backlog.splice(at, 1)
        record.landed?.('lost')
      }
      signal?.addEventListener('abort', withdraw, { once: true })
      record.done = () => signal?.removeEventListener('abort', withdraw)
      record.landed = landing => {
        record.done?.()
        settle(landing)
      }
      this.backlog.push(record)
      void this.pump()
    })
  }

  // One drain at a time. A record written while one runs is picked up by it, so a flush waits for that drain
  private pump(): Promise<void> {
    if (!this.pumping && this.log !== null && !this.closed) {
      this.pumping = true
      this.current = this.drain(this.log)
    }
    return this.current
  }

  // A close stops new records and retries, never the drain under way, so the records made before it still land
  private async drain(log: FloorLog): Promise<void> {
    try {
      while (this.backlog.length > 0) {
        const [first] = this.backlog
        let landing: Landing = 'landed'
        first.writing = true
        try {
          await log.append(first.event, first.fields)
        } catch {
          first.writing = false
          // A log that stays healthy refused the record itself, which would hold back every record after it
          if (log.healthy !== true) {
            if (first.withdrawn) {
              this.backlog.shift()
              first.landed?.('lost')
            }
            if (this.closed) this.abandon()
            else this.later()
            return
          }
          landing = 'lost'
          // Not for the count's own record, which would count itself forever
          if (first.event !== 'floor.dropped') this.overflowed++
        }
        this.backlog.shift()
        first.landed?.(landing)
        if (this.backlog.length === 0 && this.overflowed > 0) {
          this.backlog.push({ event: 'floor.dropped', fields: { count: this.overflowed } })
          this.overflowed = 0
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private later(): void {
    if (this.retry !== null || this.closed) return
    this.retry = setTimeout(() => {
      this.retry = null
      void this.pump()
    }, this.retryMs)
    this.retry.unref?.()
  }

  // Tries the backlog again at once, for a log that came back
  flush(): Promise<void> {
    return this.pump()
  }

  // A drain under way keeps going and lands what it can. With none, what still waits never will
  close(): void {
    this.closed = true
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null
    if (!this.pumping) this.abandon()
  }

  private abandon(): void {
    for (const record of this.backlog.splice(0)) record.landed?.('lost')
  }
}

// Joins a later hit's fields into the fields the record at the end of the second carries, null before the first later hit
export type Join = (held: Record<string, Field> | null, next: Record<string, Field>) => Record<string, Field>

// Floor records a plugin can trigger, one per event and key per second with a count: the first at once and the rest
// when its second is over. The key is the whole fields unless the caller names one. A plugin that picks part of the
// fields, such as the topics of a subscribe, would otherwise make a key per message, so those name a key without it
// and join what the later hits carried. Nothing counts while the human turned recording off, so no count from the gap
// lands after it
export class Coalesced {
  private readonly lane: FloorLane
  private readonly open = new Map<string, {
    event: string, fields: Record<string, Field>, later: Record<string, Field> | null, join: Join | null, count: number,
    timer: ReturnType<typeof setTimeout>,
  }>()

  constructor(lane: FloorLane) {
    this.lane = lane
  }

  hit(event: string, fields: Record<string, Field>, keyed?: { by: Record<string, Field>, join: Join }): void {
    if (!this.lane.recording) return
    const key = JSON.stringify([event, keyed?.by ?? fields])
    const found = this.open.get(key)
    if (found !== undefined) {
      found.count++
      if (found.join !== null) found.later = found.join(found.later, fields)
      return
    }
    this.lane.write(event, { ...fields, count: 1 })
    const timer = setTimeout(() => this.end(key), 1000)
    timer.unref?.()
    this.open.set(key, { event, fields, later: null, join: keyed?.join ?? null, count: 0, timer })
  }

  private end(key: string): void {
    const found = this.open.get(key)
    if (found === undefined) return
    this.open.delete(key)
    clearTimeout(found.timer)
    if (found.count > 0) this.lane.write(found.event, { ...(found.later ?? found.fields), count: found.count })
  }

  close(): void {
    for (const key of [...this.open.keys()]) this.end(key)
  }
}

const callerKey = (caller: Caller) => JSON.stringify(caller)

// queued is when the record went into the queue on the carrier's clock, which a stalled log is timed from
type Entry = { record: AuditRecord, key: string | null, queued: number }

// Audit records wait here for the log plugin, which takes them with next and acknowledges them with ack once they are
// on disk. Its handle comes with the log plugin. Bounded: one past the bound is dropped and counted. Coalescing joins a
// record to the one not yet taken with the same caller, onBehalf, root, action, code and gate state in the same second
export class AuditQueue {
  private readonly bound: () => number
  private readonly clock: () => number
  private readonly entries: Entry[] = []
  private readonly open = new Map<string, AuditRecord>()
  private second = Number.NEGATIVE_INFINITY
  private taken = 0
  private seq = 0
  // Records dropped since the queue was made, for the floor record
  dropped = 0

  // clock is the carrier's, which no change of the wall clock moves
  constructor(bound: () => number, clock: () => number = () => performance.now()) {
    this.bound = bound
    this.clock = clock
  }

  // When the oldest record still held went into the queue, taken or not, or null for an empty queue
  oldest(): number | null {
    return this.entries.length > 0 ? this.entries[0].queued : null
  }

  get size(): number {
    return this.entries.length
  }

  // false when the record was dropped for the bound
  push(record: Omit<AuditRecord, 'seq' | 'count'>, coalesce: boolean, now: number): boolean {
    const second = Math.floor(now / 1000)
    if (second !== this.second) {
      this.open.clear()
      this.second = second
    }
    const key = coalesce
      ? JSON.stringify([callerKey(record.caller), record.onBehalf ?? null, callerKey(record.root), record.action, record.code, record.gate])
      : null
    if (key !== null) {
      const found = this.open.get(key)
      if (found !== undefined) {
        found.count++
        return true
      }
    }
    if (this.entries.length >= this.bound()) {
      this.dropped++
      return false
    }
    const full: AuditRecord = { ...record, seq: ++this.seq, count: 1 }
    this.entries.push({ record: full, key, queued: this.clock() })
    if (key !== null) this.open.set(key, full)
    return true
  }

  // The next records not yet taken, oldest first. A record taken no longer coalesces
  next(max: number): AuditRecord[] {
    const out: AuditRecord[] = []
    while (out.length < max && this.taken < this.entries.length) {
      const { record, key } = this.entries[this.taken++]
      if (key !== null && this.open.get(key) === record) this.open.delete(key)
      out.push({ ...record })
    }
    return out
  }

  // Lets go of the records taken up to seq
  ack(seq: number): void {
    let n = 0
    while (n < this.taken && this.entries[n].record.seq <= seq) n++
    this.entries.splice(0, n)
    this.taken -= n
  }

  // Lets go of everything held, taken or not. Gives back how many records that was
  clear(): number {
    const held = this.entries.length
    this.entries.length = 0
    this.open.clear()
    this.taken = 0
    return held
  }
}
