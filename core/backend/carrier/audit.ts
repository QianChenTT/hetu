import type { Caller } from '../../api/envelope.ts'
import type { AuditRecord, LogSegment, LogVerification } from '../../api/slots.ts'
import type { Field } from '../../lib/event-log.ts'

// The EventLog's part the writer writes through and log.history and log.verify read. healthy still true after a failed
// append means the log refused that batch, not that the log is down
export type AuditLog = {
  appendMany(batch: readonly { event: string, fields: Record<string, Field> }[], options?: { id?: string }): Promise<void>
  history(): Promise<LogSegment[]>
  verify(): Promise<LogVerification>
  readonly healthy?: boolean
}

// The audit queue's pair the writer takes records through and lets go of them
export type AuditSource = { next(max: number): AuditRecord[], ack(seq: number): void }

// The log refuses a longer value, so a long one is cut here and never refuses a whole batch
const MAX_VALUE = 4096

const cut = (text: string) => (text.length > MAX_VALUE ? text.slice(0, MAX_VALUE) : text)

function callerText(caller: Caller): string {
  if (caller.kind === 'plugin') return `${caller.id}/${caller.half}#${caller.incarnation}`
  if (caller.kind === 'window') return `window/${caller.role}#${caller.n}`
  return `content/${caller.plugin}`
}

// A list as JSON holding the items that fit, so a path with a space in it reads back whole
function listed(items: readonly string[]): string {
  let fitting = 0
  let length = 2
  while (fitting < items.length) {
    const next = length + JSON.stringify(items[fitting]).length + (fitting > 0 ? 1 : 0)
    if (next > MAX_VALUE) break
    length = next
    fitting++
  }
  return JSON.stringify(items.slice(0, fitting))
}

// An audit record as the log's fields, every value within what the log takes. record is the queue's seq, which tells a
// record written twice from two calls and shows the order within a run. at is the time the call started, which the
// line's own at is not. The caller and root as text, the scope as JSON lists with how many there were. Never arguments
// or results, which the record doesn't hold
export function auditFields(record: AuditRecord): Record<string, Field> {
  const fields: Record<string, Field> = { record: record.seq, caller: callerText(record.caller) }
  if (record.onBehalf !== undefined) fields.onBehalf = cut(record.onBehalf)
  fields.root = callerText(record.root)
  fields.action = cut(record.action)
  const scope = record.scope
  if (scope?.paths !== undefined) {
    fields.paths = listed(scope.paths)
    fields.pathCount = scope.paths.length
  }
  if (scope?.target !== undefined) fields.target = cut(scope.target)
  if (scope?.topics !== undefined) {
    fields.topics = listed(scope.topics)
    fields.topicCount = scope.topics.length
  }
  fields.code = record.code
  fields.ms = record.ms
  fields.gate = record.gate
  fields.count = record.count
  fields.calledAt = new Date(record.at).toISOString()
  return fields
}

// What one write came to: a batch on disk, nothing to write, a batch held to try again or a batch the log refused
export type Written = 'written' | 'empty' | 'failed' | 'dropped'

export type AuditWriterOptions = {
  // Records a batch takes at most
  max?: number
  // How often a started writer writes
  everyMs?: number
  // How many records a batch held that a healthy log refused
  refused?: (count: number) => void
}

// The core's own audit writer. Every everyMs it takes up to max records from the audit queue, writes them as audit.call
// lines in one batch with one fsync and lets go of them once on disk. A batch is named by its first and last seq, which
// no other batch in the run holds. A write can throw after its lines landed, so after a failed append with the log down
// only the same batch goes, under the same id, which the log then writes once. The queue holds those records meanwhile,
// so the oldest still times how long the log has been failing. A batch a healthy log refused would hold back every
// record after it, so it is let go and counted. One write at a time: a write asked for during one waits on it
export class AuditWriter {
  private readonly source: AuditSource
  private readonly log: AuditLog
  private readonly max: number
  private readonly everyMs: number
  private readonly refused: (count: number) => void
  private held: AuditRecord[] | null = null
  private running: Promise<Written> | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(source: AuditSource, log: AuditLog, options: AuditWriterOptions = {}) {
    this.source = source
    this.log = log
    this.max = options.max ?? 256
    this.everyMs = options.everyMs ?? 100
    this.refused = options.refused ?? (() => {})
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => void this.write(), this.everyMs)
    this.timer.unref?.()
  }

  // A write under way still finishes
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  write(): Promise<Written> {
    if (this.running !== null) return this.running
    const batch = this.held ?? this.source.next(this.max)
    if (batch.length === 0) return Promise.resolve('empty')
    this.running = this.append(batch).finally(() => {
      this.running = null
    })
    return this.running
  }

  // Writes until nothing is left or a write failed. Never throws
  async flush(): Promise<void> {
    for (;;) {
      const written = await this.write()
      if (written === 'empty' || written === 'failed') return
    }
  }

  private async append(batch: AuditRecord[]): Promise<Written> {
    const last = batch[batch.length - 1].seq
    try {
      await this.log.appendMany(batch.map(record => ({ event: 'audit.call', fields: auditFields(record) })), { id: `audit:${batch[0].seq}-${last}` })
    } catch {
      if (this.log.healthy !== true) {
        this.held = batch
        return 'failed'
      }
      this.held = null
      this.source.ack(last)
      try {
        this.refused(batch.length)
      } catch {}
      return 'dropped'
    }
    this.held = null
    this.source.ack(last)
    return 'written'
  }
}
