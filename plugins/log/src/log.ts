import type { AuditHandle, AuditRecord, Call, LogRole, Prepared, Provider } from 'hetu-core/api/slots.ts'

// The most records one append writes, each batch one fsync
export const BATCH = 256
// How often the log looks for records while it runs
export const PULL_MS = 100

export type Log = {
  role: LogRole
  provider: Provider
  // Writes every record waiting, a batch at a time, and acknowledges each batch once it is written. A batch the log
  // refused is kept and written first next time, and nothing past it is acknowledged before it is written
  drain(): Promise<void>
  start(): void
  stop(): Promise<void>
}

// The log plugin: pulls the audit records through the handle the core lent it, writes them all and serves reading the
// log. It decides only which records to write and when, the core decides what each says
export function createLog(options: { pullMs?: number } = {}): Log {
  const pullMs = options.pullMs ?? PULL_MS
  let handle: AuditHandle | null = null
  let held: AuditRecord[] = []
  let tail: Promise<void> = Promise.resolve()
  let pulling = false
  let timer: ReturnType<typeof setInterval> | null = null

  async function pass(lent: AuditHandle): Promise<void> {
    for (;;) {
      if (held.length === 0) held = lent.next(BATCH)
      if (held.length === 0) return
      await lent.append(held)
      lent.ack(held[held.length - 1].seq)
      held = []
    }
  }

  // One drain at a time, a later one running after the one before it
  function drain(): Promise<void> {
    const run = tail.then(() => (handle === null ? undefined : pass(handle)))
    tail = run.catch(() => {})
    return run
  }

  // A pull while one is still writing is skipped, so a slow disk doesn't stack them up
  function pull(): void {
    if (pulling) return
    pulling = true
    drain().catch(() => {}).finally(() => {
      pulling = false
    })
  }

  return {
    role: {
      attach(lent: AuditHandle): void {
        handle = lent
      },
    },

    provider: {
      async prepare(): Promise<Prepared> {
        return { scope: {} }
      },
      async perform(call: Call): Promise<unknown> {
        if (handle === null) throw { code: 'unavailable' }
        if (call.action === 'log.history') return handle.history()
        if (call.action === 'log.verify') return handle.verify()
        throw { code: 'not-found' }
      },
    },

    drain,

    start(): void {
      timer = setInterval(pull, pullMs)
      timer.unref?.()
    },

    // The log stops last, so this last drain takes what the calls before it left
    async stop(): Promise<void> {
      if (timer !== null) clearInterval(timer)
      timer = null
      await drain().catch(() => {})
    },
  }
}
