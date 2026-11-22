import { Refused } from '@hetu/sdk'
import { doorLimits, labelOk, type Refusal } from './checks.ts'
import type { Answer, Passed } from './server.ts'

// The serving part behind the door: a request that passed every check becomes one door.handle call, which the core
// delivers to the plugin holding the role. The body goes as text and is never parsed, only the mcp- headers go with it
// and the call is made on behalf of the label the token named, never anything a request sent. A label out of its form
// is refused as a token no client holds. The holder answers a status and a body and sets no header

// The call to door.handle, made through the core with the request's signal, so a closed connection cancels it
export type CallHolder = (
  args: { body: string, headers: Record<string, string> },
  options: { onBehalf: string, signal: AbortSignal },
) => Promise<unknown>

// The statuses an answer from the holder may carry
const STATUSES: ReadonlySet<unknown> = new Set([200, 202, 400, 404])

// What a refused call answers. The holder's refusals are no refusals at the door: none is recorded and the connection
// stays. The body is fixed by the status and never names the code. The pipe answers the same word in a JSON-RPC error
export const refusedWords: Readonly<Record<number, string>> = Object.freeze({
  503: 'unavailable',
  504: 'timeout',
  429: 'throttled',
  413: 'too large',
  502: 'bad gateway',
})
const BODIES: Readonly<Record<number, string>> = Object.freeze(Object.fromEntries(Object.entries(refusedWords).map(([status, word]) => [status, JSON.stringify({ error: word })])))

const STATUS_OF: Readonly<Record<string, number>> = Object.freeze({
  unavailable: 503, starting: 503, 'policy-down': 503, 'switched-off': 503, stopped: 503, crashed: 503, 'not-granted': 503,
  // The core ended the call once the role's holder went
  stale: 503,
  timeout: 504, throttled: 429, invalid: 413,
})

const fixed = (status: number): Answer => ({ status, body: BODIES[status] })

// The call's refusal as an answer, every code it doesn't name and every other failure 502
function refusedAnswer(error: unknown): Answer {
  const status = error instanceof Refused && Object.hasOwn(STATUS_OF, error.code) ? STATUS_OF[error.code] : 502
  return fixed(status)
}

// The holder's answer as the door passes it on: exactly a status it may give and a body of text or null within the cap
function checkedAnswer(value: unknown): Answer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fixed(502)
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== 'body' || keys[1] !== 'status') return fixed(502)
  const { status, body } = value as { status: unknown, body: unknown }
  if (!STATUSES.has(status)) return fixed(502)
  if (body !== null && (typeof body !== 'string' || Buffer.byteLength(body) > doorLimits.answerBytes)) return fixed(502)
  return { status: status as number, body }
}

// The mcp- headers of the raw list, names in lower case: at most mcpHeaders of them, each name and value within its cap
// in bytes, and a name sent twice refused, since two values for one name is how two readers come to disagree
function mcpHeaders(raw: readonly string[]): { headers: Record<string, string> } | { refused: Refusal } {
  const headers: Record<string, string> = Object.create(null)
  let count = 0
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i].toLowerCase()
    if (!name.startsWith('mcp-')) continue
    const value = raw[i + 1]
    count++
    if (count > doorLimits.mcpHeaders) return { refused: { status: 431, reason: 'size' } }
    if (Buffer.byteLength(name) > doorLimits.mcpHeaderNameBytes || Buffer.byteLength(value) > doorLimits.mcpHeaderValueBytes) {
      return { refused: { status: 431, reason: 'size' } }
    }
    if (Object.hasOwn(headers, name)) return { refused: { status: 400, reason: 'malformed' } }
    headers[name] = value
  }
  return { headers: { ...headers } }
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// The serving part the door hands each request that passed. At most callsPerClient calls in flight for one client and
// callsInAll in all, past which the door refuses with rate
export function mcpServe(callHolder: CallHolder): (passed: Passed) => Promise<Answer | Refusal> {
  const inFlight = new Map<string, number>()
  let total = 0
  return async passed => {
    if (!labelOk(passed.client)) return { status: 401, reason: 'token' }
    const read = mcpHeaders(passed.headers)
    if ('refused' in read) return read.refused
    let body: string
    try {
      body = utf8.decode(passed.body)
    } catch {
      return { status: 400, reason: 'malformed' }
    }
    const own = inFlight.get(passed.client) ?? 0
    if (own >= doorLimits.callsPerClient || total >= doorLimits.callsInAll) return { status: 429, reason: 'rate' }
    inFlight.set(passed.client, own + 1)
    total++
    try {
      return checkedAnswer(await callHolder({ body, headers: read.headers }, { onBehalf: passed.client, signal: passed.signal }))
    } catch (error) {
      return refusedAnswer(error)
    } finally {
      total--
      const left = (inFlight.get(passed.client) ?? 1) - 1
      if (left === 0) inFlight.delete(passed.client)
      else inFlight.set(passed.client, left)
    }
  }
}
