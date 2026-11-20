import type { AuditRecord, Call, LogSegment, LogVerification } from '../../api/policy-jobs.ts'
import type { Field } from '../../lib/event-log.ts'

// What recording provides: the core record lane, the coalesced core records, the audit queue and its writer, the reads
// of the log and the log's failing state. Definitions only, recording.ts implements them and the join makes the one the
// carrier and the plugins manager call

// What the core record lane writes through: the one EventLog boot opened, or something with its append. healthy still
// true after a failed append means the log refused that record, not that the log is down
export type CoreRecordLog = { append(event: string, fields?: Record<string, Field>): Promise<void>, readonly healthy?: boolean }

// The EventLog's part the audit writer writes through and log.segments and log.verify read. healthy still true after a
// failed append means the log refused that batch, not that the log is down
export type AuditLog = {
  appendMany(batch: readonly { event: string, fields: Record<string, Field> }[], options?: { id?: string }): Promise<void>
  history(): Promise<LogSegment[]>
  verify(): Promise<LogVerification>
  readonly healthy?: boolean
}

// The one EventLog boot opened as recording holds it
export type CoreLog = CoreRecordLog & AuditLog

// What became of one core record: on disk, not taken while the human turned recording off, or lost: dropped from a
// full backlog, refused by the log, still waiting when the lane closed or thrown on by recording
export type Landing = 'landed' | 'muted' | 'lost'

// Joins a later hit's fields into the fields the record at the end of the second carries, null before the first later hit
export type Join = (held: Record<string, Field> | null, next: Record<string, Field>) => Record<string, Field>

// A coalesced record keyed on part of its fields, joining what the later hits carried
export type Keyed = { by: Record<string, Field>, join: Join }

// One call's audit record as the carrier hands it, before the queue numbers it
export type CallRecord = Omit<AuditRecord, 'seq' | 'count'>

// Nothing is taken in while the human has recording off, and every write answers muted then. Reads of the log answer
// whatever the switch
export type Recording = {
  // A core record from the core, which never blocks its caller
  coreRecord(event: string, fields?: Record<string, Field>): void
  // A core record a plugin can make happen again and again, one a second per event and key with a count
  coalesced(event: string, fields: Record<string, Field>, keyed?: Keyed, weight?: number): void
  // A core record its caller can wait on, landed once on disk. One still waiting when signal aborts comes out, lost
  record(event: string, fields: Record<string, Field>, signal?: AbortSignal): Promise<Landing>
  // One call's audit record into the bounded queue. coalesce joins it to a like one in the same second
  call(record: CallRecord, coalesce: boolean): void
  // The log has failed: the oldest record the audit queue holds waited logFailMs unwritten. Never while recording is off
  failing(): boolean
  // Writes what the audit queue and the backlog hold, for a log that came back and for Quit. Never throws
  flush(): Promise<void>
  // Writes what waits within ms and gives back how many records still wait. Nothing more is written until recording
  // is off or resume is called, so switching it off writes its own record last
  drain(ms: number): Promise<number>
  resume(): void
  // log.segments and log.verify
  serve(call: Call): Promise<unknown>
  // What waits is let go of once a drain under way ends. Nothing is taken in after
  close(): void
}

export type RecordingOptions = {
  log: CoreLog
  // Whether the human has recording off
  off(): boolean
  // The core-wide limits: the audit queue, the core record backlog and logFailMs
  limit(name: 'auditQueue' | 'floorBacklog' | 'logFailMs'): number
  // SHA-256 of a text as hex, for an exec command's commandHash, handed so recording reaches no Node built-in
  hash(text: string): string
  // ms since the epoch for a record's second, and a clock no change of the wall clock moves for the queue's age
  now?: () => number
  clock?: () => number
  // How long the core record lane waits before it tries a failed append again, and how often the audit writer writes
  retryMs?: number
  everyMs?: number
  // The log's health changed, so windows read core.status again
  noticed?: () => void
  // The log has failed. Told as records queue and once a second until it answers other than false
  failed?: () => boolean | void
}
