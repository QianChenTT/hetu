import type { RefusalReason } from './checks.ts'

// The most refusals one report counts, core.agentRefused's own cap
export const MAX_REPORT_COUNT = 1_000_000

// Tells the core how many refusals of one reason came since the last report
export type Report = (reason: RefusalReason, count: number) => Promise<unknown>

export type RefusalCounter = { hit(reason: RefusalReason): void, close(): void }

// Counts refusals by reason and reports each reason at most once a second with its count, so the door's refusals cost
// the core at most one call a reason a second however fast they come. A count past the cap waits for the next second.
// A report that fails is dropped, its count with it. close reports what is counted and stops
export function refusalCounter(report: Report, everyMs = 1000): RefusalCounter {
  const counts = new Map<RefusalReason, number>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const flush = () => {
    timer = null
    for (const [reason, count] of [...counts]) {
      const sent = Math.min(count, MAX_REPORT_COUNT)
      if (count > sent) counts.set(reason, count - sent)
      else counts.delete(reason)
      void report(reason, sent).catch(() => {})
    }
    if (counts.size > 0 && !closed) arm()
  }

  const arm = () => {
    timer = setTimeout(flush, everyMs)
    timer.unref?.()
  }

  return {
    hit(reason) {
      if (closed) return
      counts.set(reason, (counts.get(reason) ?? 0) + 1)
      if (timer === null) arm()
    },
    close() {
      if (closed) return
      closed = true
      if (timer !== null) clearTimeout(timer)
      flush()
    },
  }
}
