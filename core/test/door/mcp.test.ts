import { afterEach, describe, expect, it, vi } from 'vitest'
import { Refused } from '../../sdk/index.ts'
import { MAX_REFUSAL_COUNT } from '../../api/actions.ts'
import { refusalReasons, type RefusalReason } from '../../backend/door/checks.ts'
import { type CallHolder, mcpServe } from '../../backend/door/mcp.ts'
import { refusalCounter } from '../../backend/door/report.ts'
import type { Passed } from '../../backend/door/server.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const CLIENT = 'https://client.example/metadata#1'

// A request past every check of the door, as server.ts hands it on: the raw header list, names as sent
function passed(over: { body?: Buffer | string, headers?: string[], client?: string, signal?: AbortSignal } = {}): Passed {
  const body = over.body ?? '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  return {
    client: over.client ?? CLIENT,
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    headers: over.headers ?? ['Host', '127.0.0.1:4747', 'Authorization', 'Bearer secret-token', 'Content-Type', 'application/json'],
    signal: over.signal ?? new AbortController().signal,
  }
}

type Seen = { args: { body: string, headers: Record<string, string> }, options: { onBehalf: string, signal: AbortSignal } }

// An MCP that records each call and answers what answer gives
function mcp(answer: (seen: Seen) => unknown = () => ({ status: 200, body: '{"jsonrpc":"2.0","id":1,"result":{}}' })) {
  const calls: Seen[] = []
  const call: CallHolder = async (args, options) => {
    const seen = { args, options }
    calls.push(seen)
    return answer(seen)
  }
  return { calls, serve: mcpServe(call) }
}

describe('a request on its way to door.handle', () => {
  it('calls only for a label in the form <client id>#<n> and refuses any other with token, calling nothing', async () => {
    const { calls, serve } = mcp()
    for (const client of ['client', 'client#0', 'a b#1', 'cl\u0131ent#1', `${'x'.repeat(256)}#1`, '']) {
      expect(await serve(passed({ client })), JSON.stringify(client)).toEqual({ status: 401, reason: 'token' })
    }
    expect(calls).toEqual([])
    expect(await serve(passed({ client: 'client#1' }))).toMatchObject({ status: 200 })
    expect(calls.map(call => call.options.onBehalf)).toEqual(['client#1'])
  })

  it('hands the body over as text byte for byte and never parses it, a body that is not JSON and a byte order mark too', async () => {
    const { calls, serve } = mcp()
    const bodies = ['{"jsonrpc":"2.0","id":1}', 'not json at all {', '\uFEFF{"a":"\u00E9\u6F22\u{1F600}"}', '']
    for (const body of bodies) expect(await serve(passed({ body }))).toEqual({ status: 200, body: '{"jsonrpc":"2.0","id":1,"result":{}}' })
    expect(calls.map(call => Buffer.from(call.args.body, 'utf8').equals(Buffer.from(bodies[calls.indexOf(call)], 'utf8')))).toEqual([true, true, true, true])
  })

  it('passes only the mcp- headers, named in lower case, never Authorization, Host or anything else', async () => {
    const { calls, serve } = mcp()
    await serve(passed({
      headers: [
        'Host', '127.0.0.1:4747', 'Authorization', 'Bearer secret-token', 'Cookie', 'a=b', 'Origin', 'https://evil.example',
        'MCP-Protocol-Version', '2025-11-25', 'mcp-session-id', 'abc', 'Mcp-Method', 'tools/list', 'X-Mcp-Other', 'no',
        'Content-Type', 'application/json', 'Accept', 'application/json, text/event-stream',
      ],
    }))
    expect(calls[0].args.headers).toEqual({ 'mcp-protocol-version': '2025-11-25', 'mcp-session-id': 'abc', 'mcp-method': 'tools/list' })
    expect(Object.keys(calls[0].args)).toEqual(['body', 'headers'])
  })

  it('calls on behalf of the client the token named, never anything a request sent, with the request\'s signal', async () => {
    const { calls, serve } = mcp()
    const controller = new AbortController()
    await serve(passed({ client: 'client-a#1', signal: controller.signal, headers: ['X-On-Behalf', 'client-b#1', 'mcp-on-behalf', 'client-c#1'] }))
    expect(calls[0].options.onBehalf).toBe('client-a#1')
    expect(calls[0].options.signal).toBe(controller.signal)
  })

  it.each([
    ['a body that is not UTF-8', { body: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) }, { status: 400, reason: 'malformed' }],
    ['a lone surrogate encoded as bytes', { body: Buffer.from([0xed, 0xa0, 0x80]) }, { status: 400, reason: 'malformed' }],
    ['33 mcp- headers', { headers: Array.from({ length: 33 }, (_, i) => [`mcp-h${i}`, 'v']).flat() }, { status: 431, reason: 'size' }],
    ['an mcp- name of 65 bytes', { headers: [`mcp-${'n'.repeat(61)}`, 'v'] }, { status: 431, reason: 'size' }],
    ['an mcp- value of 257 bytes', { headers: ['mcp-session-id', 'v'.repeat(257)] }, { status: 431, reason: 'size' }],
    ['an mcp- name sent twice', { headers: ['mcp-session-id', 'a', 'MCP-Session-Id', 'b'] }, { status: 400, reason: 'malformed' }],
  ])('refuses %s at the door, reaching nothing', async (_name, over, refusal) => {
    const { calls, serve } = mcp()
    expect(await serve(passed(over))).toEqual(refusal)
    expect(calls).toEqual([])
  })

  it('takes 32 mcp- headers, a name of 64 bytes and a value of 256 bytes', async () => {
    const { calls, serve } = mcp()
    await serve(passed({ headers: Array.from({ length: 32 }, (_, i) => [`mcp-h${i}`, 'v']).flat() }))
    await serve(passed({ headers: [`mcp-${'n'.repeat(60)}`, 'v'.repeat(256)] }))
    expect(calls).toHaveLength(2)
  })

  it('refuses a client past 8 calls in flight and anyone past 32 in all with rate, then takes calls again once they end', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const { calls, serve } = mcp(async () => {
      await held
      return { status: 202, body: null }
    })
    const first = Array.from({ length: 8 }, () => serve(passed({ client: 'a#1' })))
    expect(await serve(passed({ client: 'a#1' }))).toEqual({ status: 429, reason: 'rate' })
    const rest = ['b#1', 'c#1', 'd#1'].flatMap(client => Array.from({ length: 8 }, () => serve(passed({ client }))))
    expect(await serve(passed({ client: 'e#1' }))).toEqual({ status: 429, reason: 'rate' })
    expect(calls).toHaveLength(32)
    release()
    expect(await Promise.all([...first, ...rest])).toEqual(Array(32).fill({ status: 202, body: null }))
    expect(await serve(passed({ client: 'a#1' }))).toEqual({ status: 202, body: null })
  })
})

describe('what door.handle answers', () => {
  it.each([
    [{ status: 200, body: '{"jsonrpc":"2.0"}' }],
    [{ status: 202, body: null }],
    [{ status: 400, body: '{"error":"bad"}' }],
    [{ status: 404, body: null }],
    [{ body: 'x'.repeat(4 * 1024 * 1024), status: 200 }],
  ])('passes on %j as its status and body', async answer => {
    const { serve } = mcp(() => answer)
    expect(await serve(passed())).toEqual({ status: answer.status, body: answer.body })
  })

  // The status is MCP's field and never read from its text
  it('takes the status from the field alone, whatever the body says', async () => {
    const { serve } = mcp(() => ({ status: 200, body: '{"status":500,"code":503}' }))
    expect(await serve(passed())).toEqual({ status: 200, body: '{"status":500,"code":503}' })
  })

  it.each([
    ['null', null],
    ['text', 'ok'],
    ['an array', [200, 'ok']],
    ['a status outside 200, 202, 400 and 404', { status: 500, body: null }],
    ['a redirect', { status: 302, body: null }],
    ['a status as text', { status: '200', body: null }],
    ['a body that is a number', { status: 200, body: 7 }],
    ['a body left out', { status: 200 }],
    ['headers of its own', { status: 200, body: null, headers: { 'Set-Cookie': 'a=b' } }],
    ['any other field', { status: 200, body: null, type: 'text/html' }],
    ['a body past 4 MiB', { status: 200, body: 'x'.repeat(4 * 1024 * 1024 + 1) }],
    ['a body past 4 MiB in bytes', { status: 200, body: '\u00E9'.repeat(2 * 1024 * 1024 + 1) }],
  ])('answers 502 with a fixed body for %s', async (_name, answer) => {
    const { serve } = mcp(() => answer)
    expect(await serve(passed())).toEqual({ status: 502, body: '{"error":"bad gateway"}' })
  })

  it.each([
    // stale is the call the core ended once the role's holder went, which the client may try again as unavailable
    ['unavailable', 503], ['starting', 503], ['policy-down', 503], ['switched-off', 503], ['stopped', 503], ['crashed', 503],
    ['not-granted', 503], ['stale', 503], ['timeout', 504], ['throttled', 429], ['invalid', 413], ['not-found', 502], ['failed', 502],
    ['needs-confirm', 502], ['guard-refused', 502], ['guard-down', 502], ['tampered', 502],
  ] as const)('answers a call refused %s with %i and a fixed body that never names the code, keeping the connection', async (refusal, status) => {
    const { serve } = mcp(() => { throw new Refused(refusal, 'door.handle') })
    const answer = await serve(passed())
    expect(answer).toMatchObject({ status })
    expect('reason' in answer).toBe(false)
    expect((answer as { body: string }).body).toMatch(/^\{"error":"[a-z ]+"\}$/)
    if (status === 502) expect((answer as { body: string }).body).toBe('{"error":"bad gateway"}')
    expect((answer as { body: string }).body.includes(refusal)).toBe(refusal === 'unavailable' || refusal === 'timeout' || refusal === 'throttled')
  })

  it('answers 502 for a call that fails with anything but a refusal', async () => {
    const { serve } = mcp(() => { throw new TypeError('broken') })
    expect(await serve(passed())).toEqual({ status: 502, body: '{"error":"bad gateway"}' })
  })
})

describe('the refusals told to the core', () => {
  it('reports each reason at most once a second with its count, so 5000 refusals in a second make at most eight calls', async () => {
    vi.useFakeTimers()
    const reports: [RefusalReason, number][] = []
    const counter = refusalCounter(async (reason, count) => { reports.push([reason, count]) })
    for (let i = 0; i < 5000; i++) counter.hit(refusalReasons[i % refusalReasons.length])
    expect(reports).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(reports).toHaveLength(8)
    expect(reports.reduce((sum, [, count]) => sum + count, 0)).toBe(5000)
    expect(new Set(reports.map(([reason]) => reason)).size).toBe(8)
    await vi.advanceTimersByTimeAsync(5000)
    expect(reports).toHaveLength(8)
    counter.hit('host')
    await vi.advanceTimersByTimeAsync(1000)
    expect(reports.at(-1)).toEqual(['host', 1])
    counter.close()
  })

  it('keeps what is past the most one report counts for the next second', async () => {
    vi.useFakeTimers()
    const reports: [RefusalReason, number][] = []
    const counter = refusalCounter(async (reason, count) => { reports.push([reason, count]) })
    for (let i = 0; i < MAX_REFUSAL_COUNT + 5; i++) counter.hit('host')
    await vi.advanceTimersByTimeAsync(1000)
    expect(reports).toEqual([['host', MAX_REFUSAL_COUNT]])
    await vi.advanceTimersByTimeAsync(1000)
    expect(reports).toEqual([['host', MAX_REFUSAL_COUNT], ['host', 5]])
    counter.close()
  })

  it('reports what it counted when it closes and nothing after, a report that fails dropped', async () => {
    vi.useFakeTimers()
    const reports: [RefusalReason, number][] = []
    const counter = refusalCounter(async (reason, count) => {
      reports.push([reason, count])
      if (reason === 'rate') throw new Refused('throttled', 'core.refused')
    })
    counter.hit('rate')
    counter.hit('token')
    counter.close()
    expect(reports).toEqual([['rate', 1], ['token', 1]])
    counter.hit('host')
    await vi.advanceTimersByTimeAsync(3000)
    expect(reports).toEqual([['rate', 1], ['token', 1]])
  })
})
