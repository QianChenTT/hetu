import type { ReasonCode, Refusal, RefusalCode } from '../api/envelope.ts'

// The one error a call rejects with when the core or the callee refused it. code and reason are core/api's fixed
// codes, so the error names no other principal's path, id or lease. request names the held security request behind
// needs-confirm
export class Refused extends Error {
  readonly code: RefusalCode
  readonly action: string
  // Left off the error when the refusal carries none
  declare readonly reason?: ReasonCode
  declare readonly request?: string

  constructor(code: RefusalCode, action = '', extra: { reason?: ReasonCode, request?: string } = {}) {
    super(`${action === '' ? 'the call' : action} was refused: ${code}${extra.reason === undefined ? '' : ` (${extra.reason})`}`)
    this.name = 'Refused'
    this.code = code
    this.action = action
    if (extra.reason !== undefined) this.reason = extra.reason
    if (extra.request !== undefined) this.request = extra.request
  }
}

// A refusal as a reply carries it. action falls back to the action the call named
export function refusedFrom(refusal: Partial<Refusal>, action: string): Refused {
  const extra: { reason?: ReasonCode, request?: string } = {}
  if (refusal.reason !== undefined) extra.reason = refusal.reason
  if (refusal.request !== undefined) extra.request = refusal.request
  return new Refused(refusal.code ?? 'failed', typeof refusal.action === 'string' && refusal.action !== '' ? refusal.action : action, extra)
}

export type TryResult<T> = { ok: true, value: T } | { ok: false, refused: Refused }

// A call's outcome as a value rather than a throw. Anything but a refusal is a bug and is thrown on
export async function attempt<T>(work: Promise<T>): Promise<TryResult<T>> {
  try {
    return { ok: true, value: await work }
  } catch (err) {
    if (err instanceof Refused) return { ok: false, refused: err }
    throw err
  }
}
