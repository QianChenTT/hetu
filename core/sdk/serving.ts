import type { Caller, ReasonCode, RefusalCode } from '../api/envelope.ts'
import { VERSION } from '../api/version.ts'
import { type Client, makeClient, type Request } from './client.ts'
import { Refused } from './refused.ts'

// A call another plugin or a window made to one of the plugin's own actions, as the carrier delivered it. caller is
// who the carrier says made it. signal aborts once the carrier gives the call up. ctx makes sub-calls with this call
// as their parent, held to its deadline
export type IncomingCall = {
  readonly callId: string
  readonly caller: Caller
  readonly action: string
  readonly onBehalf?: string
  readonly deadline: number
  readonly signal: AbortSignal
  readonly ctx: Client
}

// args come from another plugin as it wrote them, so the handler checks them
export type Handler = (call: IncomingCall, args: unknown) => unknown

// Deeper than any call needs, the same cap as core/api's
const MAX_DEPTH = 64
const badKeys = new Set(['__proto__', 'constructor', 'prototype'])

// Whether a value can cross as a result: plain objects with Object's prototype or none, arrays, strings, finite
// numbers, booleans, null and undefined, nothing reached twice and nothing deeper than 64. The carrier refuses the
// rest anyway. Some of it can't even be posted, so the SDK answers failed at once
export function isPlain(value: unknown): boolean {
  const seen = new Set<object>()
  const walk = (item: unknown, depth: number): boolean => {
    if (item === null || item === undefined) return true
    if (typeof item === 'string' || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isFinite(item)
    if (typeof item !== 'object' || depth > MAX_DEPTH || seen.has(item)) return false
    seen.add(item)
    if (Array.isArray(item)) return item.every(entry => walk(entry, depth + 1))
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Object.keys(item).every(key => !badKeys.has(key) && walk((item as Record<string, unknown>)[key], depth + 1))
  }
  return walk(value, 1)
}

type Answer = { ok: true, result: unknown } | { ok: false, refusal: { code: RefusalCode, action: string, reason?: ReasonCode } }

// The plugin's own actions: a handler per <id>.<name> and the calls being served
export class Serving {
  private readonly id: string
  private readonly send: (message: unknown) => void
  private readonly request: Request
  private readonly handlers = new Map<string, Handler>()
  private readonly live = new Map<string, AbortController>()

  constructor(id: string, send: (message: unknown) => void, request: Request) {
    this.id = id
    this.send = send
    this.request = request
  }

  provide(name: string, handler: Handler): void {
    if (typeof name !== 'string' || name === '' || name.includes('.')) throw new TypeError('provide needs an action name with no dot')
    if (typeof handler !== 'function') throw new TypeError('provide needs a handler')
    this.handlers.set(`${this.id}.${name}`, handler)
  }

  filterReadable(call: IncomingCall, paths: readonly string[]): Promise<string[]> {
    return this.request('core.filterReadable', { call: call.callId, paths: [...paths] }) as Promise<string[]>
  }

  async deliver(message: Record<string, unknown>): Promise<void> {
    const { callId, caller, action, args, deadline, onBehalf } = message
    if (typeof callId !== 'string' || typeof action !== 'string' || this.live.has(callId)) return
    const controller = new AbortController()
    this.live.set(callId, controller)
    const due = typeof deadline === 'number' ? deadline : 0
    const call: IncomingCall = Object.freeze({
      callId,
      caller: caller as Caller,
      action,
      ...(typeof onBehalf === 'string' ? { onBehalf } : {}),
      deadline: due,
      signal: controller.signal,
      ctx: makeClient(this.request, { callId, deadline: due }),
    })
    const answer = await this.answer(call, args)
    this.live.delete(callId)
    this.send({ v: VERSION, kind: 'reply', callId, ...answer })
  }

  // The carrier gave a call up. Its handler hears it through the signal and its answer is no longer read
  cancel(message: Record<string, unknown>): void {
    const { callId } = message
    if (typeof callId === 'string') this.live.get(callId)?.abort()
  }

  private async answer(call: IncomingCall, args: unknown): Promise<Answer> {
    const handler = this.handlers.get(call.action)
    if (handler === undefined) return refused('failed', call.action)
    try {
      const result = await handler(call, args)
      return isPlain(result) ? { ok: true, result } : refused('failed', call.action)
    } catch (err) {
      if (err instanceof Refused) return refused(err.code, call.action, err.reason)
      console.error(`hetu: ${call.action} threw`, err)
      return refused('failed', call.action)
    }
  }
}

function refused(code: RefusalCode, action: string, reason?: ReasonCode): Answer {
  return { ok: false, refusal: reason === undefined ? { code, action } : { code, action, reason } }
}
