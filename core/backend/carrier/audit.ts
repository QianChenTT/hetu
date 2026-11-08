import type { Caller } from '../../api/envelope.ts'
import { frozen } from '../../api/plain.ts'
import type { AuditHandle, AuditRecord, LogSegment, LogVerification } from '../../api/slots.ts'
import type { Field } from '../../lib/event-log.ts'

// The EventLog's part the handle writes and reads through
export type AuditLog = {
  appendMany(batch: readonly { event: string, fields: Record<string, Field> }[], options?: { id?: string }): Promise<void>
  history(): Promise<LogSegment[]>
  verify(): Promise<LogVerification>
}

// The audit queue's pair, as the carrier exposes it
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

// The handle the log plugin holds for one incarnation, and revoke, which the loader calls when that incarnation is
// over. The handle keeps its own copy of each record it hands out, so what the plugin does to its copy writes nothing,
// and forgets a copy once it is written or acknowledged. Records go in the order they were handed out, never below one
// already written, and a record being written can't be in another batch. A write can throw after its lines landed, so
// after a failed append only the same batch goes, under the same id, which the log then writes once, until it is
// written or acknowledged. skipped hears how many records an ack let go of that were never written
export function lendAudit(source: AuditSource, log: AuditLog, skipped?: (count: number) => void): { handle: AuditHandle, revoke(): void } {
  let live = true
  const handed = new Map<number, AuditRecord>()
  const writing = new Set<number>()
  let lastWritten = 0
  let failed: readonly number[] | null = null
  const check = () => {
    if (!live) throw new Error('the audit handle was revoked')
  }

  const handle: AuditHandle = {
    next(max: number): AuditRecord[] {
      check()
      if (!Number.isSafeInteger(max) || max < 0) throw new Error('next takes a whole number of records')
      const records = source.next(max)
      for (const record of records) handed.set(record.seq, record)
      return records.map(record => structuredClone(record))
    },

    async append(batch: readonly AuditRecord[]): Promise<void> {
      check()
      if (!Array.isArray(batch)) throw new Error('append takes a list of records')
      const seqs = batch.map(record => (record as { seq?: unknown } | null)?.seq)
      const own: AuditRecord[] = []
      let below = lastWritten
      for (const seq of seqs) {
        const record = typeof seq === 'number' ? handed.get(seq) : undefined
        if (record === undefined || writing.has(record.seq) || record.seq <= below) {
          throw new Error('a record the handle didn\'t hand out, one written already or one out of order')
        }
        below = record.seq
        own.push(record)
      }
      if (failed !== null && (failed.length !== own.length || own.some((record, i) => record.seq !== failed![i]))) {
        throw new Error('the batch that failed goes first')
      }
      const mine = own.map(record => record.seq)
      for (const seq of mine) writing.add(seq)
      try {
        await log.appendMany(own.map(record => ({ event: 'audit.call', fields: auditFields(record) })), { id: `audit:${mine.join(',')}` })
      } catch (err) {
        failed = mine
        throw err
      } finally {
        for (const seq of mine) writing.delete(seq)
      }
      failed = null
      lastWritten = mine[mine.length - 1]
      for (const seq of mine) handed.delete(seq)
    },

    ack(seq: number): void {
      check()
      if (!Number.isSafeInteger(seq)) throw new Error('ack takes a seq')
      source.ack(seq)
      let unwritten = 0
      for (const taken of handed.keys()) {
        if (taken > seq) continue
        handed.delete(taken)
        if (!writing.has(taken)) unwritten++
      }
      if (failed !== null && failed.every(taken => taken <= seq)) failed = null
      if (unwritten > 0) {
        try {
          skipped?.(unwritten)
        } catch {}
      }
    },

    async history(): Promise<LogSegment[]> {
      check()
      return log.history()
    },

    async verify(): Promise<LogVerification> {
      check()
      return log.verify()
    },
  }

  return {
    handle: frozen(handle),
    revoke() {
      live = false
      handed.clear()
    },
  }
}
