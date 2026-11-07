import type { Refusal, RefusalCode } from '../api/envelope.ts'
import { VERSION } from '../api/version.ts'
import { isPlain } from './plain.ts'
import { Refused, refusedFrom } from './refused.ts'

// onBehalf names one of the caller's own clients, which grants nothing. timeoutMs only shortens the call's deadline
export type CallOptions = { signal?: AbortSignal, timeoutMs?: number, onBehalf?: string }

// parent names the call this one serves and deadline is that call's, in ms since the epoch. The carrier holds a
// sub-call to its parent's deadline, so retries stop there too
export type RequestOptions = CallOptions & { parent?: string, deadline?: number }

export type Limits = { callsInFlight: number, callDeadlineMs: number }

// Refusals that pass once the core or the callee catches up, retried within the call's deadline
const retried = new Set<RefusalCode>(['starting', 'throttled'])
const FIRST_RETRY_MS = 25
const LAST_RETRY_MS = 1000
// How long past a deadline the carrier holds to the call waits for the carrier's own timeout
const REPLY_SLACK_MS = 1000
// The longest delay a timer takes. A longer one fires at once
const MAX_TIMER_MS = 2 ** 31 - 1

type Sender = { send(message: unknown, onFail?: (error: unknown) => void): void }

type Pending = {
  readonly action: string
  readonly args: unknown
  readonly options: RequestOptions
  readonly deadline: number
  // The deadline is the caller's own timeoutMs, which the carrier never hears of
  readonly own: boolean
  readonly settle: (outcome: { value: unknown } | { error: unknown }) => void
  // The id of the message in flight, null while the call waits for a turn or a retry
  id: number | null
  delay: number
  // The carrier's deadline passed and the call waits a second more for the carrier's own timeout
  slack: boolean
  // The refusal a retry answers, which the call settles with once its deadline leaves no room for another
  last: Refused | null
  retryTimer: ReturnType<typeof setTimeout> | null
  deadlineTimer: ReturnType<typeof setTimeout> | null
  readonly abort: () => void
}

const timer = (fn: () => void, ms: number) => setTimeout(fn, Math.min(Math.max(0, ms), MAX_TIMER_MS))

// The half's own calls. Args that can't cross are refused invalid at once. Past callsInFlight a call waits its turn.
// starting and throttled are tried again after a delay that doubles from 25 ms to a second, while the deadline allows.
// A call settles timeout at its deadline wherever it is. One still waiting is never sent. One the caller's own
// timeoutMs gave up on is cancelled at once. One held to the carrier's deadline waits a second more for the carrier's
// own answer before it is cancelled too. An aborted signal cancels a call that went out
export class Calls {
  private readonly sender: Sender
  private readonly limits: Limits
  private readonly inFlight = new Map<number, Pending>()
  private readonly waiting: Pending[] = []
  private readonly all = new Set<Pending>()
  private next = 1
  private pumpQueued = false
  // Set once the half stopped, after which no call goes out
  private closed: RefusalCode | null = null

  constructor(sender: Sender, limits: Limits) {
    this.sender = sender
    this.limits = limits
  }

  request(action: string, args: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.closed !== null) return Promise.reject(new Refused(this.closed, action))
    const { signal } = options
    if (signal?.aborted === true) return Promise.reject(signal.reason)
    if (!isPlain(args)) return Promise.reject(new Refused('invalid', action))
    const now = Date.now()
    const carrier = Math.min(now + this.limits.callDeadlineMs, options.deadline ?? Infinity)
    const { timeoutMs } = options
    const mine = timeoutMs === undefined ? Infinity : now + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0)
    const deadline = Math.min(carrier, mine)
    if (deadline <= now) return Promise.reject(new Refused('timeout', action))
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        action, args, options, deadline, own: mine < carrier, id: null, delay: FIRST_RETRY_MS, slack: false, last: null,
        retryTimer: null, deadlineTimer: null,
        // Settled first and forgotten after, so a call waiting its turn can't hold up one that already has its answer
        settle: outcome => {
          if (!this.all.has(pending)) return
          if ('value' in outcome) resolve(outcome.value)
          else reject(outcome.error)
          this.forget(pending)
        },
        abort: () => {
          if (pending.id !== null) this.sender.send({ v: VERSION, kind: 'cancel', id: pending.id })
          pending.settle({ error: signal!.reason })
        },
      }
      signal?.addEventListener('abort', pending.abort, { once: true })
      pending.deadlineTimer = timer(() => this.due(pending), deadline - now)
      this.all.add(pending)
      this.waiting.push(pending)
      this.pump()
    })
  }

  // Settles every call with code and refuses any made after
  close(code: RefusalCode): void {
    this.closed = code
    for (const pending of [...this.all]) pending.settle({ error: new Refused(code, pending.action) })
  }

  // A reply to one of the half's calls. One for no call in flight, a stale or a doubled one, is dropped
  reply(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const { kind, id, ok, result, refusal } = message as { kind?: unknown, id?: unknown, ok?: unknown, result?: unknown, refusal?: unknown }
    if (kind !== 'reply' || typeof id !== 'number') return
    const pending = this.inFlight.get(id)
    if (pending === undefined) return
    this.landed(pending)
    if (ok === true) return pending.settle({ value: result })
    const refused = refusedFrom((typeof refusal === 'object' && refusal !== null ? refusal : {}) as Partial<Refusal>, pending.action)
    if (retried.has(refused.code) && Date.now() + pending.delay < pending.deadline) return this.retry(pending, refused)
    pending.settle({ error: refused })
  }

  private pump(): void {
    if (this.closed !== null) return
    while (this.inFlight.size < this.limits.callsInFlight && this.waiting.length > 0) {
      const next = this.waiting.shift()!
      // Its timer may not have run yet, but a call past its deadline never goes out
      if (Date.now() >= next.deadline) next.settle({ error: next.last ?? new Refused('timeout', next.action) })
      else this.send(next)
    }
  }

  // A pump after a call settles waits a microtask, so it never runs inside another call's settling
  private pumpLater(): void {
    if (this.pumpQueued) return
    this.pumpQueued = true
    queueMicrotask(() => {
      this.pumpQueued = false
      this.pump()
    })
  }

  private send(pending: Pending): void {
    const id = this.next++
    pending.id = id
    this.inFlight.set(id, pending)
    const message: Record<string, unknown> = { v: VERSION, kind: 'call', id, action: pending.action, args: pending.args }
    if (pending.options.parent !== undefined) message.parent = pending.options.parent
    if (pending.options.onBehalf !== undefined) message.onBehalf = pending.options.onBehalf
    // A message the port can't copy never reached the carrier, so the call is refused here
    this.sender.send(message, () => {
      if (pending.id === id) pending.settle({ error: new Refused('invalid', pending.action) })
    })
  }

  private retry(pending: Pending, refused: Refused): void {
    const delay = pending.delay
    pending.delay = Math.min(delay * 2, LAST_RETRY_MS)
    pending.last = refused
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = null
      this.waiting.push(pending)
      this.pump()
    }, delay)
  }

  // The call's deadline came. One that never went out settles with its last refusal or timeout. One that went out is
  // cancelled, at once for the caller's own deadline and a second later for the carrier's, whose own timeout answers
  // first when the message arrived
  private due(pending: Pending): void {
    pending.deadlineTimer = null
    if (pending.id === null) return pending.settle({ error: pending.last ?? new Refused('timeout', pending.action) })
    if (!pending.own && !pending.slack) {
      pending.slack = true
      pending.deadlineTimer = timer(() => this.due(pending), REPLY_SLACK_MS)
      return
    }
    this.sender.send({ v: VERSION, kind: 'cancel', id: pending.id })
    pending.settle({ error: new Refused('timeout', pending.action) })
  }

  // A reply came, so the call no longer holds a place in flight
  private landed(pending: Pending): void {
    if (pending.id !== null) this.inFlight.delete(pending.id)
    pending.id = null
  }

  private forget(pending: Pending): void {
    if (!this.all.delete(pending)) return
    this.landed(pending)
    for (const handle of [pending.retryTimer, pending.deadlineTimer]) if (handle !== null) clearTimeout(handle)
    pending.retryTimer = null
    pending.deadlineTimer = null
    const at = this.waiting.indexOf(pending)
    if (at >= 0) this.waiting.splice(at, 1)
    pending.options.signal?.removeEventListener('abort', pending.abort)
    this.pumpLater()
  }
}
