import type { Refusal } from '../api/envelope.ts'
import { VERSION } from '../api/version.ts'
import { refusedFrom } from './refused.ts'

// onBehalf names one of the caller's own clients, which grants nothing. timeoutMs shortens the call's deadline
export type CallOptions = { signal?: AbortSignal, timeoutMs?: number, onBehalf?: string }

// parent names the call this one serves, which the carrier holds to that call's deadline
export type RequestOptions = CallOptions & { parent?: string }

type Pending = { action: string, resolve: (value: unknown) => void, reject: (error: unknown) => void }

// The half's own calls: each request gets the next id and its reply settles it, a refusal as a Refused
export class Calls {
  private readonly send: (message: unknown) => void
  private readonly pending = new Map<number, Pending>()
  private next = 1

  constructor(send: (message: unknown) => void) {
    this.send = send
  }

  request(action: string, args: unknown, options: RequestOptions = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.next++
      this.pending.set(id, { action, resolve, reject })
      const message: Record<string, unknown> = { v: VERSION, kind: 'call', id, action, args }
      if (options.parent !== undefined) message.parent = options.parent
      if (options.onBehalf !== undefined) message.onBehalf = options.onBehalf
      this.send(message)
    })
  }

  // A reply to one of the half's calls. One for no call pending, a stale or a doubled one, is dropped
  reply(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const { kind, id, ok, result, refusal } = message as { kind?: unknown, id?: unknown, ok?: unknown, result?: unknown, refusal?: unknown }
    if (kind !== 'reply' || typeof id !== 'number') return
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    if (ok === true) pending.resolve(result)
    else pending.reject(refusedFrom((typeof refusal === 'object' && refusal !== null ? refusal : {}) as Partial<Refusal>, pending.action))
  }
}
