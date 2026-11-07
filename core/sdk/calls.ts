import type { Refusal, RefusalCode } from '../api/envelope.ts'
import { VERSION } from '../api/version.ts'
import { Refused, refusedFrom } from './refused.ts'

// onBehalf names one of the caller's own clients, which grants nothing. timeoutMs shortens the call's deadline
export type CallOptions = { signal?: AbortSignal, timeoutMs?: number, onBehalf?: string }

// parent names the call this one serves and deadline is that call's, in ms since the epoch. The carrier holds a
// sub-call to its parent's deadline, so retries stop there too
export type RequestOptions = CallOptions & { parent?: string, deadline?: number }

export type Limits = { callsInFlight: number, callDeadlineMs: number }

// Refusals that pass once the core or the callee catches up, retried within the call's deadline
const retried = new Set<RefusalCode>(['starting', 'throttled'])
const FIRST_RETRY_MS = 25
const LAST_RETRY_MS = 1000
// How long past its deadline a call waits for the carrier's own timeout before it gives up on the reply
const REPLY_SLACK_MS = 1000
// The longest delay a timer takes. A longer one fires at once
const MAX_TIMER_MS = 2 ** 31 - 1

type Pending = {
  readonly action: string
  readonly args: unknown
  readonly options: RequestOptions
  readonly deadline: number
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  // The id of the message in flight, null while the call waits for a turn or a retry
  id: number | null
  delay: number
  timer: ReturnType<typeof setTimeout> | null
  readonly abort: () => void
}

// The half's own calls. Past callsInFlight a call waits its turn. starting and throttled are tried again after a delay
// that doubles from 25 ms to at most a second, while the deadline allows. A call with no reply by its deadline plus a
// second settles timeout, since the carrier drops a message over the rate unanswered. An aborted signal cancels it
export class Calls {
  private readonly sender: { send(message: unknown): void }
  private readonly limits: Limits
  private readonly inFlight = new Map<number, Pending>()
  private readonly waiting: Pending[] = []
  private readonly all = new Set<Pending>()
  private next = 1
  // Set once the half stopped, after which no call goes out
  private closed: RefusalCode | null = null

  constructor(sender: { send(message: unknown): void }, limits: Limits) {
    this.sender = sender
    this.limits = limits
  }

  request(action: string, args: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.closed !== null) return Promise.reject(new Refused(this.closed, action))
    const { signal } = options
    if (signal?.aborted === true) return Promise.reject(signal.reason)
    const now = Date.now()
    const deadline = Math.min(now + (options.timeoutMs ?? this.limits.callDeadlineMs), options.deadline ?? Infinity)
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        action, args, options, deadline, id: null, delay: FIRST_RETRY_MS, timer: null,
        resolve: value => {
          this.forget(pending)
          resolve(value)
        },
        reject: error => {
          this.forget(pending)
          reject(error)
        },
        abort: () => {
          if (pending.id !== null) this.sender.send({ v: VERSION, kind: 'cancel', id: pending.id })
          pending.reject(signal!.reason)
        },
      }
      signal?.addEventListener('abort', pending.abort, { once: true })
      this.all.add(pending)
      this.waiting.push(pending)
      this.pump()
    })
  }

  // Settles every call with code and refuses any made after
  close(code: RefusalCode): void {
    this.closed = code
    for (const pending of [...this.all]) pending.reject(new Refused(code, pending.action))
  }

  // A reply to one of the half's calls. One for no call in flight, a stale or a doubled one, is dropped
  reply(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const { kind, id, ok, result, refusal } = message as { kind?: unknown, id?: unknown, ok?: unknown, result?: unknown, refusal?: unknown }
    if (kind !== 'reply' || typeof id !== 'number') return
    const pending = this.inFlight.get(id)
    if (pending === undefined) return
    this.landed(pending)
    if (ok === true) return pending.resolve(result)
    const refused = refusedFrom((typeof refusal === 'object' && refusal !== null ? refusal : {}) as Partial<Refusal>, pending.action)
    if (retried.has(refused.code) && Date.now() + pending.delay < pending.deadline) return this.retry(pending)
    pending.reject(refused)
  }

  private pump(): void {
    if (this.closed !== null) return
    while (this.inFlight.size < this.limits.callsInFlight && this.waiting.length > 0) this.send(this.waiting.shift()!)
  }

  private send(pending: Pending): void {
    const id = this.next++
    pending.id = id
    this.inFlight.set(id, pending)
    const wait = Math.min(Math.max(0, pending.deadline + REPLY_SLACK_MS - Date.now()), MAX_TIMER_MS)
    pending.timer = setTimeout(() => pending.reject(new Refused('timeout', pending.action)), wait)
    const message: Record<string, unknown> = { v: VERSION, kind: 'call', id, action: pending.action, args: pending.args }
    if (pending.options.parent !== undefined) message.parent = pending.options.parent
    if (pending.options.onBehalf !== undefined) message.onBehalf = pending.options.onBehalf
    this.sender.send(message)
  }

  private retry(pending: Pending): void {
    const delay = pending.delay
    pending.delay = Math.min(delay * 2, LAST_RETRY_MS)
    pending.timer = setTimeout(() => {
      pending.timer = null
      this.waiting.push(pending)
      this.pump()
    }, delay)
  }

  // A reply came, so the call no longer holds a place in flight
  private landed(pending: Pending): void {
    if (pending.id !== null) this.inFlight.delete(pending.id)
    pending.id = null
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.timer = null
  }

  private forget(pending: Pending): void {
    if (!this.all.delete(pending)) return
    this.landed(pending)
    const at = this.waiting.indexOf(pending)
    if (at >= 0) this.waiting.splice(at, 1)
    pending.options.signal?.removeEventListener('abort', pending.abort)
    this.pump()
  }
}
