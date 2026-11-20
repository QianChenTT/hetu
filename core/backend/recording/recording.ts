import type { Call } from '../../api/policy-jobs.ts'
import type { Field } from '../../lib/event-log.ts'
import { AuditWriter } from './audit.ts'
import type { CallRecord, Keyed, Landing, Recording, RecordingOptions } from './header.ts'
import { AuditQueue, Coalesced, CoreRecordLane } from './records.ts'

// Recording: core records go first, straight through the one EventLog, and audit records wait in a bounded queue the
// writer takes in batches. It enforces nothing: the caller on the same step decides whether to wait for a record to
// land. The log counts as failed once the oldest record the queue holds waited logFailMs unwritten, which it tells
// until taken. With the human's switch off nothing is taken in and what the queue still holds is let go, since the
// switch's own record counted it and is the last one written
export function createRecording(options: RecordingOptions): Recording {
  return new Recorder(options)
}

class Recorder implements Recording {
  private readonly options: RecordingOptions
  private readonly now: () => number
  private readonly clock: () => number
  private readonly lane: CoreRecordLane
  private readonly coalescer: Coalesced
  private readonly queue: AuditQueue
  private readonly writer: AuditWriter
  // The once a second look, and the log's health it last saw
  private readonly looking: ReturnType<typeof setInterval>
  private healthy: boolean | undefined
  private told = false
  // Drained for recording to go off: the writer writes nothing more until the switch applies or resume is called
  private paused = false
  private closed = false

  constructor(options: RecordingOptions) {
    const { log, now = Date.now, clock = () => performance.now() } = options
    this.options = options
    this.now = now
    this.clock = clock
    this.lane = new CoreRecordLane(log, {
      bound: () => options.limit('floorBacklog'),
      muted: () => options.off(),
      retryMs: options.retryMs ?? 5000,
      noticed: () => options.noticed?.(),
    })
    this.coalescer = new Coalesced(this.lane)
    this.queue = new AuditQueue(() => options.limit('auditQueue'), this.clock)
    // Between the drain and the switch nothing is written, so no call record lands after the switch's own
    const source = {
      next: (max: number) => {
        if (options.off()) {
          this.queue.clear()
          this.paused = false
          return []
        }
        return this.paused ? [] : this.queue.next(max)
      },
      ack: (seq: number) => this.queue.ack(seq),
    }
    // A batch the log refused while healthy is let go and counted, one record a batch
    this.writer = new AuditWriter(source, log, {
      everyMs: options.everyMs ?? 100,
      hash: options.hash,
      refused: count => {
        void this.lane.write('audit.dropped', { why: 'refused', count })
      },
    })
    this.writer.start()
    this.healthy = log.healthy
    this.looking = setInterval(() => this.look(), 1000)
    this.looking.unref?.()
  }

  coreRecord(event: string, fields: Record<string, Field> = {}): void {
    void this.lane.write(event, fields)
  }

  coalesced(event: string, fields: Record<string, Field>, keyed?: Keyed, weight?: number): void {
    this.coalescer.hit(event, fields, keyed, weight)
  }

  record(event: string, fields: Record<string, Field>, signal?: AbortSignal): Promise<Landing> {
    return this.lane.write(event, fields, signal)
  }

  // One past the queue's bound is dropped and counted
  call(record: CallRecord, coalesce: boolean): void {
    if (this.options.off()) return
    if (!this.queue.push(record, coalesce, this.now())) this.coalescer.hit('audit.dropped', { why: 'full' })
    this.check()
  }

  // Timed from when the record was queued, so a long call doesn't count
  failing(): boolean {
    if (this.options.off()) return false
    const oldest = this.queue.oldest()
    return oldest !== null && this.clock() - oldest >= this.options.limit('logFailMs')
  }

  async flush(): Promise<void> {
    await this.writer.flush()
    await this.lane.flush()
  }

  async drain(ms: number): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, ms)
    })
    await Promise.race([this.flush(), deadline])
    clearTimeout(timer)
    this.paused = true
    return this.queue.size + this.lane.waiting
  }

  // Recording didn't go off after a drain, so the writer goes on
  resume(): void {
    this.paused = false
  }

  async serve(call: Call): Promise<unknown> {
    return call.action === 'log.segments' ? this.options.log.history() : this.options.log.verify()
  }

  close(): void {
    this.closed = true
    clearInterval(this.looking)
    this.writer.stop()
    this.coalescer.close()
    this.lane.close()
  }

  // Tells that the log failed, as records queue and once a second, until it is taken
  private check(): void {
    if (this.told || !this.failing()) return
    try {
      if (this.options.failed?.() !== false) this.told = true
    } catch {}
  }

  // Once a second, so windows hear when the log's health changed through an audit write, which the lane doesn't see
  private look(): void {
    if (this.closed) return
    this.check()
    const healthy = this.options.log.healthy
    if (healthy === this.healthy) return
    this.healthy = healthy
    try {
      this.options.noticed?.()
    } catch {}
  }
}
