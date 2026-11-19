import type { Caller } from '../../api/envelope.ts'
import type { LimitName } from '../../api/limits.ts'
import type { Field } from '../../lib/event-log.ts'
import type { Landing, Port } from '../carrier/header.ts'

// The carrier says what became of a core record, so the type lives with it
export type { Landing }

// What the plugins manager needs from the carrier, a small interface the plugins manager's tests fake. register and end are the
// carrier's own. The join builds send, record, changed, stopping and limit in the carrier
export type CarrierLink = {
  // Binds a half's port to its caller. The plugins manager calls it in the same step that mints the port
  register(port: Port, caller: Caller): void
  // Ends a way: a planned stop or a revoked incarnation. Its calls answer code and nothing more arrives from it
  end(caller: Caller, code?: 'stopped' | 'crashed'): void
  // A lifecycle message down a half's own way: init, deps or stop. Dropped when the way is gone
  send(caller: Caller, message: unknown): void
  // A core record into the core record lane, never blocking. The promise settles with landed once that
  // one record is on disk. It settles at once with muted while the human turned recording off. It settles with lost
  // when the backlog dropped it, the log refused it or the lane closed with it still waiting. It never rejects. A copy,
  // an update or a restore applies only on landed or muted, so a record the log can't write yet holds the change back
  // until it lands or the plugins manager gives up. A plugins manager that gives up aborts signal, which takes a record still waiting
  // out of the backlog and settles it lost
  record(event: string, fields: Record<string, Field>, signal?: AbortSignal): Promise<Landing>
  // A policy job state, a plugin state or the grants snapshot changed, so the carrier asks the gate about live subscriptions again
  changed(): void
  // Shutdown has begun. The policy job states have no stopping, so shutdown says so here instead. From this call on the
  // carrier answers stopped where it would answer policy-down, guard-down or unavailable for a policy job, a guard or a
  // provider that is down, a provider the core modules closed included. It writes no policy job change as a failure
  // either
  stopping(): void
  // Writes what the audit queue and the core record backlog hold, waiting at most ms, and gives back how many records still
  // wait. Record nothing's switch drains first, so its own record is the last one written
  drain(ms: number): Promise<number>
  // Recording didn't go off after a drain, so the audit writer goes on
  resume(): void
  // A limit as it applies to one plugin: the human's value for it or for all, lowered by the watchdog. The
  // plugins manager takes readyMs and stopGraceMs from here so both follow the same values the carrier enforces
  limit(plugin: string, name: LimitName): number
}
