import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { doorLimits, type Refusal, type RefusalReason, type TokenSeam } from '../src/checks.ts'
import { type Answer, type Door, openDoor, type Passed } from '../src/server.ts'

// Every test drives the door with raw sockets, so any Host, header or framing can be sent as written and nothing is
// normalised on the way

const doors: Door[] = []
const sockets: net.Socket[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const door of doors.splice(0)) await door.close()
})

type Made = { door: Door, port: number, refused: RefusalReason[], passed: Passed[] }

async function made(options: {
  token?: TokenSeam
  serve?: (passed: Passed) => Promise<Answer | Refusal>
  limits?: Parameters<typeof openDoor>[0]['limits']
  clock?: () => number
  ready?: () => boolean
} = {}): Promise<Made> {
  const refused: RefusalReason[] = []
  const passed: Passed[] = []
  const door = await openDoor({
    port: 0,
    token: options.token ?? (async () => null),
    serve: async call => {
      passed.push(call)
      return options.serve ? options.serve(call) : { status: 200, body: '{"ok":true}' }
    },
    refused: reason => void refused.push(reason),
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.ready !== undefined ? { ready: options.ready } : {}),
  })
  doors.push(door)
  return { door, port: door.address.port, refused, passed }
}

const anyToken: TokenSeam = async text => (text === 'Bearer good' ? { client: 'https://client.example/metadata' } : null)

type Exchange = { raw: string, closed: boolean, closedAfterMs: number | null }

// Writes the text as it is and reads until the socket closes or waitMs passed
async function exchange(port: number, text: string | Buffer, waitMs = 2000): Promise<Exchange> {
  const socket = net.connect({ host: '127.0.0.1', port })
  sockets.push(socket)
  let raw = ''
  let closed = false
  let closedAt: number | null = null
  socket.on('data', data => {
    raw += data.toString('latin1')
  })
  socket.on('error', () => {})
  socket.on('close', () => {
    closed = true
    closedAt = performance.now()
  })
  await new Promise(resolve => socket.once('connect', resolve))
  const started = performance.now()
  if (text.length > 0) socket.write(text)
  while (!closed && performance.now() - started < waitMs) await new Promise(resolve => setTimeout(resolve, 5))
  return { raw, closed, closedAfterMs: closedAt === null ? null : closedAt - started }
}

type Response = { status: number, headers: [string, string][], body: string }

// Every response in what came back, each with its header names and values as sent
function responses(raw: string): Response[] {
  const out: Response[] = []
  let rest = raw
  while (rest.startsWith('HTTP/')) {
    const end = rest.indexOf('\r\n\r\n')
    if (end < 0) break
    const [line, ...lines] = rest.slice(0, end).split('\r\n')
    const headers = lines.map(text => {
      const colon = text.indexOf(':')
      return [text.slice(0, colon), text.slice(colon + 1).trim()] as [string, string]
    })
    const length = Number(headers.find(([name]) => name.toLowerCase() === 'content-length')?.[1] ?? 0)
    const chunked = headers.some(([name, value]) => name.toLowerCase() === 'transfer-encoding' && value === 'chunked')
    let body = rest.slice(end + 4, end + 4 + length)
    let next = end + 4 + length
    if (chunked) {
      const stop = rest.indexOf('0\r\n\r\n', end + 4)
      body = ''
      next = stop + 5
    }
    out.push({ status: Number(line.split(' ')[1]), headers, body })
    rest = rest.slice(next)
  }
  return out
}

const header = (response: Response, name: string) => response.headers.find(([key]) => key.toLowerCase() === name)?.[1]
const names = (response: Response) => response.headers.map(([name]) => name.toLowerCase()).sort()

const request = (lines: string[], body = '') => `${lines.join('\r\n')}\r\n\r\n${body}`
const post = (port: number, extra: string[] = [], body = '{}') =>
  request(['POST /mcp HTTP/1.1', `Host: 127.0.0.1:${port}`, `Content-Length: ${Buffer.byteLength(body)}`, ...extra], body)

// The headers every response carries and those Node adds, and nothing else
const fixed = ['cache-control', 'content-security-policy', 'x-content-type-options']
function expectOnlyOwnHeaders(response: Response, extra: string[]): void {
  expect(names(response)).toEqual([...fixed, 'content-length', 'date', ...extra].sort())
  expect(header(response, 'cache-control')).toBe('no-store')
  expect(header(response, 'x-content-type-options')).toBe('nosniff')
  expect(header(response, 'content-security-policy')).toBe('default-src \'none\'; frame-ancestors \'none\'')
}

describe('the bind', () => {
  it('listens on 127.0.0.1 alone, read back from the socket', async () => {
    const { door } = await made()
    expect(door.address.address).toBe('127.0.0.1')
    expect(door.address.family).toBe('IPv4')
    // The IPv6 loopback has no listener on that port
    const error = await new Promise<string>(resolve => {
      const socket = net.connect({ host: '::1', port: door.address.port })
      socket.on('connect', () => {
        socket.destroy()
        resolve('connected')
      })
      socket.on('error', err => resolve((err as NodeJS.ErrnoException).code ?? 'error'))
    })
    expect(error).not.toBe('connected')
  })

  it('rejects when the port is taken and tries no other', async () => {
    const { port } = await made()
    const listen = vi.spyOn(http.Server.prototype, 'listen')
    await expect(openDoor({ port, token: async () => null, serve: async () => ({ status: 200, body: null }), refused: () => {} }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(listen).toHaveBeenCalledTimes(1)
  })

  it('sets Node\'s server to the door\'s limits and the strict parser', async () => {
    const { door } = await made()
    const server = door.server
    expect(server.headersTimeout).toBe(doorLimits.headersMs)
    expect(server.requestTimeout).toBe(doorLimits.requestMs)
    expect(server.keepAliveTimeout).toBe(doorLimits.keepAliveMs)
    expect(server.maxRequestsPerSocket).toBe(doorLimits.requestsPerSocket)
    expect(server.maxConnections).toBe(doorLimits.connections)
    expect(door.parser).toEqual({ maxHeaderSize: doorLimits.headerBytes, insecureHTTPParser: false, requireHostHeader: false })
  })

  it('closes the socket on close', async () => {
    const { door, port } = await made()
    await door.close()
    doors.splice(0)
    const error = await new Promise<string>(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.on('connect', () => {
        socket.destroy()
        resolve('connected')
      })
      socket.on('error', err => resolve((err as NodeJS.ErrnoException).code ?? 'error'))
    })
    expect(error).toBe('ECONNREFUSED')
  })
})

describe('the Host check on the wire', () => {
  it.each([
    ['no Host', (port: number) => request(['POST /mcp HTTP/1.1', 'Content-Length: 0'])],
    ['another name', () => post(0, []).replace(/Host: [^\r]*/, 'Host: evil.example')],
    ['another port', (port: number) => post(port).replace(`127.0.0.1:${port}`, `127.0.0.1:${port + 1}`)],
    ['localhost', (port: number) => post(port).replace('127.0.0.1', 'localhost')],
    ['the name upper case', (port: number) => post(port).replace('127.0.0.1', 'LOCALHOST')],
    ['a trailing dot', (port: number) => post(port).replace('127.0.0.1', '127.0.0.1.')],
    ['userinfo', (port: number) => post(port).replace('127.0.0.1', 'user@127.0.0.1')],
    ['127.1', (port: number) => post(port).replace('127.0.0.1', '127.1')],
    ['a decimal address', (port: number) => post(port).replace('127.0.0.1', '2130706433')],
    ['an empty Host', (port: number) => post(port).replace(`127.0.0.1:${port}`, '')],
    ['two Host headers, the right one first', (port: number) => post(port, ['Host: evil.example'])],
    ['two Host headers, the right one last', (port: number) => post(port).replace('Host:', 'Host: evil.example\r\nHost:')],
    ['two right Host headers', (port: number) => post(port, [`Host: 127.0.0.1:${port}`])],
    ['an absolute target', (port: number) => post(port).replace('POST /mcp', `POST http://127.0.0.1:${port}/mcp`)],
    ['an absolute target on another name', (port: number) => post(port).replace('POST /mcp', 'POST http://evil.example/mcp')],
    ['HTTP/1.0 with no Host', () => request(['POST /mcp HTTP/1.0', 'Content-Length: 0'])],
  ])('answers 403 to %s, reaches nothing and records host', async (_name, text) => {
    const { port, refused, passed } = await made({ token: anyToken })
    const { raw, closed } = await exchange(port, text(port).replace('Content-Length: 2\r\n', 'Content-Length: 2\r\nAuthorization: Bearer good\r\n'))
    const [response] = responses(raw)
    expect(response.status).toBe(403)
    expectOnlyOwnHeaders(response, ['connection'])
    expect(header(response, 'connection')).toBe('close')
    expect(closed).toBe(true)
    expect(refused).toEqual(['host'])
    expect(passed).toEqual([])
  })

  // The door's own address as an authority is still no path, so the Host check refuses it
  it('refuses a CONNECT to the door\'s own address and closes, never tunnelling', async () => {
    const { port, passed, refused } = await made({ token: anyToken })
    const { raw, closed } = await exchange(port, request([`CONNECT 127.0.0.1:${port} HTTP/1.1`, `Host: 127.0.0.1:${port}`]))
    expect(responses(raw).map(response => response.status)).toEqual([403])
    expect(closed).toBe(true)
    expect(passed).toEqual([])
    expect(refused).toEqual(['host'])
  })
})

describe('the Origin and Sec-Fetch-Site checks on the wire', () => {
  it.each(['null', 'http://127.0.0.1:4747', 'http://127.0.0.1:5173', 'http://localhost:4747', 'https://evil.example'])(
    'answers 403 to Origin %s and records origin',
    async origin => {
      const { port, refused, passed } = await made({ token: anyToken })
      const [response] = responses((await exchange(port, post(port, [`Origin: ${origin}`, 'Authorization: Bearer good']))).raw)
      expect(response.status).toBe(403)
      expect(refused).toEqual(['origin'])
      expect(passed).toEqual([])
    },
  )

  it.each(['cross-site', 'same-site', 'None'])('answers 403 to Sec-Fetch-Site %s and records origin', async value => {
    const { port, refused } = await made({ token: anyToken })
    const [response] = responses((await exchange(port, post(port, [`Sec-Fetch-Site: ${value}`, 'Authorization: Bearer good']))).raw)
    expect(response.status).toBe(403)
    expect(refused).toEqual(['origin'])
  })

  it('passes Sec-Fetch-Site none and same-origin', async () => {
    const { port, passed } = await made({ token: anyToken })
    for (const value of ['none', 'same-origin']) {
      const [response] = responses((await exchange(port, post(port, [`Sec-Fetch-Site: ${value}`, 'Authorization: Bearer good', 'Connection: close']))).raw)
      expect(response.status).toBe(200)
    }
    expect(passed).toHaveLength(2)
  })
})

describe('the route table on the wire', () => {
  it('answers 405 naming POST to GET and DELETE on /mcp, before the token', async () => {
    const { port, refused, passed } = await made()
    for (const method of ['GET', 'DELETE']) {
      const [response] = responses((await exchange(port, request([`${method} /mcp HTTP/1.1`, `Host: 127.0.0.1:${port}`]))).raw)
      expect(response.status).toBe(405)
      expect(header(response, 'allow')).toBe('POST')
      expectOnlyOwnHeaders(response, ['allow', 'connection'])
    }
    expect(refused).toEqual(['method', 'method'])
    expect(passed).toEqual([])
  })

  it.each([
    ['PUT /mcp HTTP/1.1', 404], ['HEAD /mcp HTTP/1.1', 404], ['OPTIONS /mcp HTTP/1.1', 404], ['POST / HTTP/1.1', 404],
    ['POST /mcp?x=1 HTTP/1.1', 404], ['POST /mcp/ HTTP/1.1', 404], ['POST /MCP HTTP/1.1', 404], ['GET /favicon.ico HTTP/1.1', 404],
    ['POST /.well-known/oauth-protected-resource/mcp HTTP/1.1', 404], ['POST /mcp HTTP/1.0', 505], ['POST /mcp HTTP/2.0', 505],
  ])('answers %s with %i and records method', async (line, status) => {
    const { port, refused, passed } = await made({ token: anyToken })
    const [response] = responses((await exchange(port, request([line, `Host: 127.0.0.1:${port}`, 'Authorization: Bearer good', 'Content-Length: 0']))).raw)
    expect(response.status).toBe(status)
    expect(refused).toEqual(['method'])
    expect(passed).toEqual([])
  })

  it('answers 400 to a WebSocket or h2c upgrade and never switches protocols', async () => {
    const { port, refused } = await made({ token: anyToken })
    const websocket = ['GET /mcp HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==']
    const h2c = ['POST /mcp HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: Upgrade, HTTP2-Settings', 'Upgrade: h2c', 'HTTP2-Settings: AAMAAABkAAQAAP__', 'Authorization: Bearer good', 'Content-Length: 0']
    for (const lines of [websocket, h2c]) {
      const [response] = responses((await exchange(port, request(lines))).raw)
      expect(response.status).toBe(400)
    }
    expect(refused).toEqual(['method', 'method'])
  })
})

describe('the token check', () => {
  // RFC 9728: the challenge names where the resource's metadata is, on the door's own port
  it('answers 401 with a Bearer challenge naming the resource metadata when no token passes and records token', async () => {
    const { port, refused, passed } = await made()
    const [response] = responses((await exchange(port, post(port, ['Authorization: Bearer good']))).raw)
    expect(response.status).toBe(401)
    expect(header(response, 'www-authenticate')).toBe(`Bearer resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp"`)
    expectOnlyOwnHeaders(response, ['www-authenticate', 'connection'])
    expect(refused).toEqual(['token'])
    expect(passed).toEqual([])
  })

  it('hands the seam the one Authorization header and asks it nothing for none or two', async () => {
    const seen: (string | null)[] = []
    const { port, passed } = await made({ token: text => (seen.push(text), anyToken(text)) })
    await exchange(port, post(port, ['Authorization: Bearer good', 'Connection: close']))
    await exchange(port, post(port, ['Authorization: Bearer good', 'Authorization: Bearer good']))
    await exchange(port, post(port))
    expect(seen).toEqual(['Bearer good'])
    expect(passed).toHaveLength(1)
  })

  it('passes a request that passed every check with the client, the body as bytes and the raw headers', async () => {
    const { port, passed } = await made({ token: anyToken })
    const [response] = responses((await exchange(port, post(port, ['Authorization: Bearer good', 'Mcp-Protocol-Version: 2025-11-25', 'Connection: close'], 'not json at all'))).raw)
    expect(response.status).toBe(200)
    expect(response.body).toBe('{"ok":true}')
    expect(header(response, 'content-type')).toBe('application/json')
    expect(passed).toHaveLength(1)
    expect(passed[0].client).toBe('https://client.example/metadata')
    expect(passed[0].body.toString('utf8')).toBe('not json at all')
    expect(passed[0].headers).toContain('Mcp-Protocol-Version')
  })
})

// The token check takes time once tokens exist, and the socket may be refused or closed while it runs
describe('a token check that settles later', () => {
  const later = <T>(ms: number, value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms))
  const client = { client: 'https://client.example/metadata' }

  // Checked again once the check settles, so neither a 100 Continue nor a read of the body follows
  it('serves nothing and writes no 100 Continue when the client closed its socket while the check ran', async () => {
    const continued = vi.spyOn(http.ServerResponse.prototype, 'writeContinue')
    let settled = 0
    const { port, passed, refused } = await made({ token: async () => { const answer = await later(300, client); settled++; return answer } })
    const socket = net.connect({ host: '127.0.0.1', port })
    sockets.push(socket)
    socket.on('error', () => {})
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write(post(port, ['Authorization: Bearer good', 'Expect: 100-continue']))
    await new Promise(resolve => setTimeout(resolve, 50))
    socket.destroy()
    await vi.waitFor(() => expect(settled).toBe(1), { timeout: 2000 })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(passed).toEqual([])
    expect(refused).toEqual([])
    expect(continued).not.toHaveBeenCalled()
  })

  it('serves nothing and writes no 100 Continue behind a request refused on its socket while the check ran', async () => {
    const continued = vi.spyOn(http.ServerResponse.prototype, 'writeContinue')
    let settled = 0
    const { port, passed, refused } = await made({
      token: async text => { const answer = await (text === 'Bearer good' ? later(300, client) : later(100, null)); settled++; return answer },
    })
    const answered = responses((await exchange(port, post(port, ['Authorization: Bearer bad']) + post(port, ['Authorization: Bearer good', 'Expect: 100-continue']))).raw)
    await vi.waitFor(() => expect(settled).toBe(2), { timeout: 2000 })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(answered.map(response => response.status)).toEqual([401])
    expect(refused).toEqual(['token'])
    expect(passed).toEqual([])
    expect(continued).not.toHaveBeenCalled()
  })

  it('writes the answers of two requests on one socket in the order they came, whichever check settled first', async () => {
    const { port, passed } = await made({
      token: async text => (text === 'Bearer slow' ? later(300, { client: 'slow' }) : later(10, { client: 'fast' })),
      serve: async call => ({ status: 200, body: JSON.stringify({ client: call.client }) }),
    })
    const answered = responses((await exchange(port, post(port, ['Authorization: Bearer slow']) + post(port, ['Authorization: Bearer fast', 'Connection: close']))).raw)
    expect(answered.map(response => [response.status, response.body])).toEqual([[200, '{"client":"slow"}'], [200, '{"client":"fast"}']])
    expect(passed.map(call => call.client).sort()).toEqual(['fast', 'slow'])
  })

  it('hands on no Authorization header in any spelling, so nothing behind the door can pass it on', async () => {
    const { port, passed } = await made({ token: anyToken })
    await exchange(port, post(port, ['Authorization: Bearer good', 'Mcp-Session-Id: s-1', 'Connection: close']))
    await exchange(port, request(['POST /mcp HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Content-Length: 2', 'AUTHORIZATION: Bearer good', 'Connection: close'], '{}'))
    expect(passed).toHaveLength(2)
    for (const call of passed) {
      expect(call.headers.filter((_, i) => i % 2 === 0).map(name => name.toLowerCase())).not.toContain('authorization')
      expect(call.headers.join('\n')).not.toContain('Bearer good')
    }
    expect(passed[0].headers).toEqual(expect.arrayContaining(['Mcp-Session-Id', 's-1']))
  })
})

describe('what a response carries', () => {
  it('carries only the door\'s own headers whatever the request sent or the answer held, and never a CORS header', async () => {
    const { port } = await made({
      token: anyToken,
      serve: async () => ({ status: 200, body: '{}', headers: { 'Set-Cookie': 'a=b', 'Access-Control-Allow-Origin': '*' } }) as Answer,
    })
    const sent = [
      'Authorization: Bearer good', 'X-Echo: reflected', 'Access-Control-Request-Method: POST', 'Access-Control-Request-Headers: x-echo',
      'Cookie: a=b', 'Mcp-Session-Id: s1', 'Connection: close',
    ]
    const [response] = responses((await exchange(port, post(port, sent))).raw)
    expect(response.status).toBe(200)
    expectOnlyOwnHeaders(response, ['content-type', 'connection'])
    expect(response.headers.some(([name]) => name.toLowerCase().startsWith('access-control-'))).toBe(false)
    expect(JSON.stringify(response.headers)).not.toContain('reflected')
  })

  it('answers with no body when the answer has none', async () => {
    const { port } = await made({ token: anyToken, serve: async () => ({ status: 202, body: null }) })
    const [response] = responses((await exchange(port, post(port, ['Authorization: Bearer good', 'Connection: close']))).raw)
    expect(response.status).toBe(202)
    expect(response.body).toBe('')
    expectOnlyOwnHeaders(response, ['connection'])
  })

  it('answers 502 when serving throws or names a status it can\'t write', async () => {
    for (const serve of [async () => { throw new Error('no') }, async () => ({ status: 99, body: null })]) {
      const { port } = await made({ token: anyToken, serve })
      const [response] = responses((await exchange(port, post(port, ['Authorization: Bearer good', 'Connection: close']))).raw)
      expect(response.status).toBe(502)
      expect(response.body).toBe('')
    }
  })
})

describe('sizes', () => {
  it('answers 431 to more than 8 KiB of headers with the door\'s headers and records size', async () => {
    const { port, refused, passed } = await made({ token: anyToken })
    const under = await exchange(port, post(port, ['Authorization: Bearer good', `X-Pad: ${'a'.repeat(7600)}`, 'Connection: close']))
    expect(responses(under.raw)[0].status).toBe(200)
    const over = await exchange(port, post(port, ['Authorization: Bearer good', `X-Pad: ${'a'.repeat(8300)}`]))
    const [response] = responses(over.raw)
    expect(response.status).toBe(431)
    expectOnlyOwnHeaders(response, ['connection'])
    expect(over.closed).toBe(true)
    expect(refused).toEqual(['size'])
    expect(passed).toHaveLength(1)
  })

  it('answers 413 to a declared body over 512 KiB before reading it and records size', async () => {
    const { port, refused, passed } = await made({ token: anyToken })
    const text = request(['POST /mcp HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Authorization: Bearer good', `Content-Length: ${doorLimits.mcpBodyBytes + 1}`])
    const { raw, closed } = await exchange(port, text)
    expect(responses(raw)[0].status).toBe(413)
    expect(closed).toBe(true)
    expect(refused).toEqual(['size'])
    expect(passed).toEqual([])
  })

  it('takes a body of exactly 512 KiB', async () => {
    const { port, passed } = await made({ token: anyToken })
    const body = 'x'.repeat(doorLimits.mcpBodyBytes)
    const { raw } = await exchange(port, post(port, ['Authorization: Bearer good', 'Connection: close'], body), 5000)
    expect(responses(raw)[0].status).toBe(200)
    expect(passed[0].body.length).toBe(doorLimits.mcpBodyBytes)
  })

  it('answers 413 to a chunked body that grows past 512 KiB, reaches nothing and records size', async () => {
    const { port, refused, passed } = await made({ token: anyToken })
    const chunk = 'y'.repeat(64 * 1024)
    const chunks = Array.from({ length: 9 }, () => `${(64 * 1024).toString(16)}\r\n${chunk}\r\n`).join('')
    const text = request(['POST /mcp HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Authorization: Bearer good', 'Transfer-Encoding: chunked'], `${chunks}0\r\n\r\n`)
    const { raw, closed } = await exchange(port, text, 5000)
    expect(responses(raw)[0].status).toBe(413)
    expect(closed).toBe(true)
    expect(refused).toEqual(['size'])
    expect(passed).toEqual([])
  })

  it('asks for a body only once the request passed every check, answering Expect: 100-continue', async () => {
    const { port } = await made({ token: anyToken })
    const lines = ['POST /mcp HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Content-Length: 2', 'Expect: 100-continue']
    const refusedRaw = (await exchange(port, request([...lines, 'Origin: null']), 500)).raw
    expect(refusedRaw.startsWith('HTTP/1.1 403')).toBe(true)
    expect(refusedRaw).not.toContain('100 Continue')
    const tokenless = (await exchange(port, request(lines), 500)).raw
    expect(tokenless.startsWith('HTTP/1.1 401')).toBe(true)
    const passing = (await exchange(port, request([...lines, 'Authorization: Bearer good']), 500)).raw
    expect(passing.startsWith('HTTP/1.1 100 Continue')).toBe(true)
  })
})

describe('the parser', () => {
  it.each([
    ['Content-Length with Transfer-Encoding', ['Content-Length: 5', 'Transfer-Encoding: chunked'], '0\r\n\r\n'],
    ['two Content-Length values', ['Content-Length: 2', 'Content-Length: 3'], '{}x'],
    ['Transfer-Encoding not ending in chunked', ['Transfer-Encoding: chunked, identity'], '0\r\n\r\n'],
    ['a folded header', ['X-A: one', ' two', 'Content-Length: 0'], ''],
    ['a space before the colon', ['Host : evil.example', 'Content-Length: 0'], ''],
    ['a NUL in a value', ['X-A: a\u0000b', 'Content-Length: 0'], ''],
  ])('answers 400 to %s with the door\'s headers, reaches nothing and records malformed', async (_name, extra, body) => {
    const { port, passed, refused } = await made({ token: anyToken })
    const text = request(['POST /mcp HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Authorization: Bearer good', ...extra], body)
    const { raw, closed } = await exchange(port, text)
    const [response] = responses(raw)
    expect(response.status).toBe(400)
    expectOnlyOwnHeaders(response, ['connection'])
    expect(closed).toBe(true)
    expect(passed).toEqual([])
    expect(refused).toEqual(['malformed'])
  })

  it('answers 400 to bare line feeds and to the HTTP/2 preface, each recorded malformed', async () => {
    const { port, passed, refused } = await made({ token: anyToken })
    for (const text of [`POST /mcp HTTP/1.1\nHost: 127.0.0.1:${port}\nContent-Length: 0\n\n`, 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n']) {
      expect(responses((await exchange(port, text)).raw)[0].status).toBe(400)
    }
    expect(passed).toEqual([])
    expect(refused).toEqual(['malformed', 'malformed'])
  })

  it('records a refusal the serving part gives by its reason, answers it with no body and closes', async () => {
    const { port, refused } = await made({ token: anyToken, serve: async () => ({ status: 431, reason: 'size' }) })
    const { raw, closed } = await exchange(port, post(port, ['Authorization: Bearer good']))
    const [response] = responses(raw)
    expect(response.status).toBe(431)
    expect(response.body).toBe('')
    expectOnlyOwnHeaders(response, ['connection'])
    expect(closed).toBe(true)
    expect(refused).toEqual(['size'])
  })
})

describe('requests behind one another on a socket', () => {
  it.each([
    ['another Host', ['Host: evil.example', 'Authorization: Bearer good'], 403],
    ['an Origin with a body', ['Origin: https://evil.example', 'Authorization: Bearer good'], 403],
    ['no token', [], 401],
  ])('serves nothing written behind a request refused for %s, the refused one answered alone and the socket closed', async (_name, extra, status) => {
    const { port, passed } = await made({ token: anyToken })
    const refused = request(['POST /mcp HTTP/1.1', ...(extra.some(line => line.startsWith('Host:')) ? [] : [`Host: 127.0.0.1:${port}`]), ...extra, 'Content-Length: 2'], '{}')
    const { raw, closed } = await exchange(port, refused + post(port, ['Authorization: Bearer good']))
    expect(responses(raw).map(response => response.status)).toEqual([status])
    expect(closed).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(passed).toEqual([])
  })

  it('serves good requests written behind one another, each answered in order', async () => {
    const { port, passed } = await made({ token: anyToken })
    const good = post(port, ['Authorization: Bearer good'])
    const { raw } = await exchange(port, good + good, 1000)
    expect(responses(raw).map(response => response.status)).toEqual([200, 200])
    expect(passed).toHaveLength(2)
  })

  it('cancels every call a connection carried when it closes, not only the first', async () => {
    let aborted = 0
    const { port, passed } = await made({
      token: anyToken,
      serve: call => new Promise(resolve => {
        call.signal.addEventListener('abort', () => {
          aborted++
          resolve({ status: 200, body: null })
        })
      }),
    })
    const good = post(port, ['Authorization: Bearer good'])
    const socket = net.connect({ host: '127.0.0.1', port })
    sockets.push(socket)
    socket.on('error', () => {})
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write(good + good + good)
    for (let waited = 0; passed.length < 3 && waited < 2000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5))
    expect(passed).toHaveLength(3)
    socket.destroy()
    for (let waited = 0; aborted < 3 && waited < 2000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5))
    expect(aborted).toBe(3)
  })
})

describe('the requests Node would answer itself', () => {
  it('answers an Expect other than 100-continue with its own 417 after the checks, recorded malformed, and closes', async () => {
    const { port, passed, refused } = await made({ token: anyToken })
    const { raw, closed } = await exchange(port, post(port, ['Authorization: Bearer good', 'Expect: something-else']))
    const [response] = responses(raw)
    expect(response.status).toBe(417)
    expectOnlyOwnHeaders(response, ['connection'])
    expect(closed).toBe(true)
    expect(passed).toEqual([])
    expect(refused).toEqual(['malformed'])
  })

  it('meets an Expect with the Host and Origin checks first', async () => {
    const { port, refused } = await made({ token: anyToken })
    const text = request(['POST /mcp HTTP/1.1', 'Host: evil.example', 'Origin: https://evil.example', 'Expect: something-else', 'Content-Length: 2'], '{}')
    const [response] = responses((await exchange(port, text)).raw)
    expect(response.status).toBe(403)
    expect(refused).toEqual(['host'])
  })

  it.each([
    ['another host', (port: number) => ['CONNECT evil.example:443 HTTP/1.1', `Host: 127.0.0.1:${port}`], 403, 'host'],
    ['the door\'s own path', (port: number) => ['CONNECT /mcp HTTP/1.1', `Host: 127.0.0.1:${port}`], 404, 'method'],
  ])('refuses a CONNECT to %s through the checks with the door\'s headers, recorded, and closes', async (_name, lines, status, reason) => {
    const { port, passed, refused } = await made({ token: anyToken })
    const { raw, closed } = await exchange(port, request(lines(port)))
    const [response] = responses(raw)
    expect(response.status).toBe(status)
    expectOnlyOwnHeaders(response, ['connection'])
    expect(closed).toBe(true)
    expect(passed).toEqual([])
    expect(refused).toEqual([reason])
  })
})

type Held = { socket: net.Socket, raw: () => string, ended: () => boolean, error: () => string | null }

// The door's next connection, or the next count of them, once its server has taken them. The client's connect can come
// first, and on macOS it does
const accepted = (door: Door, count = 1) => new Promise<void>(resolve => {
  let taken = 0
  const took = () => {
    if (++taken < count) return
    door.server.off('connection', took)
    resolve()
  }
  door.server.on('connection', took)
})

// A socket that never closes its own side and reads what comes until the test ends, once the door holds it
async function hold(door: Door, text: string): Promise<Held> {
  const taken = accepted(door)
  const socket = net.connect({ host: '127.0.0.1', port: door.address.port, allowHalfOpen: true })
  sockets.push(socket)
  let raw = ''
  let ended = false
  let error: string | null = null
  socket.on('data', data => {
    raw += data.toString('latin1')
  })
  socket.on('end', () => {
    ended = true
  })
  socket.on('error', err => {
    error = (err as NodeJS.ErrnoException).code ?? 'error'
  })
  await Promise.all([new Promise(resolve => socket.once('connect', resolve)), taken])
  if (text.length > 0) socket.write(text)
  return { socket, raw: () => raw, ended: () => ended, error: () => error }
}

const openAt = (door: Door) => new Promise<number>((resolve, reject) => door.server.getConnections((err, count) => (err ? reject(err) : resolve(count))))

// Waits until the door holds no socket or the time passed and gives the count then
async function drained(door: Door, withinMs: number): Promise<number> {
  const started = performance.now()
  let open = await openAt(door)
  while (open > 0 && performance.now() - started < withinMs) {
    await new Promise(resolve => setTimeout(resolve, 10))
    open = await openAt(door)
  }
  return open
}

describe('sockets answered past Node\'s response', () => {
  const connect = (port: number) => request([`CONNECT 127.0.0.1:${port} HTTP/1.1`, `Host: 127.0.0.1:${port}`])

  it.each([
    ['a CONNECT', connect, 403, 'host'],
    ['bytes the parser refuses', () => 'GARBAGE\r\n\r\n', 400, 'malformed'],
    ['headers past the limit', (port: number) => post(port, [`X-Pad: ${'a'.repeat(9000)}`]), 431, 'size'],
  ])('lets go of a socket it answered %s on within a second, the client keeping its side open', async (_name, text, status, reason) => {
    const { door, port, refused } = await made({ token: anyToken })
    const held = await hold(door, text(port))
    expect(await drained(door, 1000)).toBe(0)
    const [response] = responses(held.raw())
    expect(response.status).toBe(status)
    expectOnlyOwnHeaders(response, ['connection'])
    expect(held.ended()).toBe(true)
    expect(held.error()).toBe(null)
    expect(refused).toEqual([reason])
  })

  it('lets go of a silent socket once it answered 408, the client keeping its side open', async () => {
    const { door, port, refused } = await made({ limits: { headersMs: 300, requestMs: 600, keepAliveMs: 300, checkMs: 50 } })
    const held = await hold(door, '')
    expect(await drained(door, 2000)).toBe(0)
    expect(responses(held.raw()).map(response => response.status)).toEqual([408])
    expect(refused).toEqual(['timeout'])
  })

  it('answers a good request while 64 refused CONNECT sockets are held open by their client', async () => {
    const { door, port, refused } = await made({ token: anyToken })
    const holders: Held[] = []
    for (let i = 0; i < doorLimits.connections; i++) holders.push(await hold(door, connect(port)))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(holders.every(holder => holder.raw().startsWith('HTTP/1.1 403'))).toBe(true)
    expect(await drained(door, 1000)).toBe(0)
    const [response] = responses((await exchange(port, post(port, ['Authorization: Bearer good', 'Connection: close']))).raw)
    expect(response.status).toBe(200)
    expect(refused).toEqual(Array(doorLimits.connections).fill('host'))
  })

  // A loopback socket takes a 4 MiB answer at once on this platform, so a flush that never ends is stood in for
  it('lets go of a socket whose raw answer is never flushed once the request time passed', async () => {
    const { door, port } = await made({ token: anyToken, limits: { headersMs: 300, requestMs: 600, keepAliveMs: 300, checkMs: 50 } })
    vi.spyOn(net.Socket.prototype, 'end').mockImplementation(function (this: net.Socket, data?: unknown) {
      if (typeof data === 'string') this.write(data)
      return this
    })
    await hold(door, connect(port))
    expect(await drained(door, 300)).toBe(1)
    expect(await drained(door, 1500)).toBe(0)
  })

  it('hands the whole answer to a client that reads it only after the door let go', async () => {
    const { door, port } = await made({ token: anyToken })
    for (const text of [connect(port), 'GARBAGE\r\n\r\n']) {
      const taken = accepted(door)
      const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true })
      sockets.push(socket)
      socket.on('error', () => {})
      await Promise.all([new Promise(resolve => socket.once('connect', resolve)), taken])
      socket.pause()
      socket.write(text)
      expect(await drained(door, 1000)).toBe(0)
      let raw = ''
      socket.on('data', data => {
        raw += data.toString('latin1')
      })
      const end = new Promise(resolve => socket.once('end', resolve))
      socket.resume()
      await end
      const [response] = responses(raw)
      expectOnlyOwnHeaders(response, ['connection'])
      expect(raw.endsWith('\r\n\r\n')).toBe(true)
    }
  })
})

describe('a refusal behind a request still being served', () => {
  const connect = (port: number) => request([`CONNECT 127.0.0.1:${port} HTTP/1.1`, `Host: 127.0.0.1:${port}`])

  // Calls that answer their own number after ms, counted as run to their end or cancelled before it
  function slowCalls(ms: number) {
    const counts = { made: 0, ended: 0, cancelled: 0 }
    const serve = (call: Passed) => new Promise<Answer>(resolve => {
      const n = ++counts.made
      let done = false
      const timer = setTimeout(() => {
        done = true
        counts.ended++
        resolve({ status: 200, body: `{"n":${n}}` })
      }, ms)
      call.signal.addEventListener('abort', () => {
        if (done) return
        counts.cancelled++
        clearTimeout(timer)
        resolve({ status: 200, body: null })
      })
    })
    return { counts, serve }
  }

  it.each([
    ['a CONNECT', connect, 403, 'host'],
    ['bytes the parser refuses', () => 'GARBAGE\r\n\r\n', 400, 'malformed'],
  ])('answers the request ahead first, then refuses %s, records it once and lets go of the socket', async (_name, behind, status, reason) => {
    for (const apartMs of [0, 100]) {
      const { counts, serve } = slowCalls(300)
      const { door, port, refused } = await made({ token: anyToken, serve })
      const good = post(port, ['Authorization: Bearer good'])
      const held = await hold(door, apartMs === 0 ? good + behind(port) : good)
      if (apartMs > 0) {
        await new Promise(resolve => setTimeout(resolve, apartMs))
        held.socket.write(behind(port))
      }
      expect(await drained(door, 1500)).toBe(0)
      expect(responses(held.raw()).map(response => [response.status, response.body])).toEqual([[200, '{"n":1}'], [status, '']])
      expect(held.ended()).toBe(true)
      expect(counts).toEqual({ made: 1, ended: 1, cancelled: 0 })
      expect(refused).toEqual([reason])
    }
  })

  it('answers every request ahead in order before the refusal', async () => {
    const { counts, serve } = slowCalls(300)
    const { door, port, refused } = await made({ token: anyToken, serve })
    const good = post(port, ['Authorization: Bearer good'])
    const held = await hold(door, good + good + connect(port))
    expect(await drained(door, 1500)).toBe(0)
    expect(responses(held.raw()).map(response => response.status)).toEqual([200, 200, 403])
    expect(responses(held.raw()).map(response => response.body).slice(0, 2).sort()).toEqual(['{"n":1}', '{"n":2}'])
    expect(counts).toEqual({ made: 2, ended: 2, cancelled: 0 })
    expect(refused).toEqual(['host'])
  })

  // Node's headers time runs out on a socket whose parser failed, a second clientError while the refusal waits
  it('keeps the first refusal\'s answer when the headers time also runs out while it waits', async () => {
    const { counts, serve } = slowCalls(900)
    const { door, port, refused } = await made({ token: anyToken, serve, limits: { headersMs: 300, requestMs: 2000, keepAliveMs: 300, checkMs: 50 } })
    const held = await hold(door, post(port, ['Authorization: Bearer good']) + 'GARBAGE\r\n\r\n')
    expect(await drained(door, 2500)).toBe(0)
    expect(responses(held.raw()).map(response => [response.status, response.body])).toEqual([[200, '{"n":1}'], [400, '']])
    expect(counts).toEqual({ made: 1, ended: 1, cancelled: 0 })
    expect(refused).toEqual(['malformed'])
  })

  it('answers a request read to its end before the 408 of one behind it whose body is late', async () => {
    const { counts, serve } = slowCalls(900)
    const { door, port, refused } = await made({ token: anyToken, serve, limits: { headersMs: 300, requestMs: 600, keepAliveMs: 300, checkMs: 50 } })
    const good = post(port, ['Authorization: Bearer good'])
    const late = good.replace('Content-Length: 2', 'Content-Length: 50')
    const held = await hold(door, good + late)
    expect(await drained(door, 2500)).toBe(0)
    expect(responses(held.raw()).map(response => [response.status, response.body])).toEqual([[200, '{"n":1}'], [408, '']])
    expect(counts).toEqual({ made: 1, ended: 1, cancelled: 0 })
    expect(refused).toEqual(['timeout'])
  })

  it('writes nothing ahead of an answer that never comes and lets go of the socket after the request time, the call cancelled', async () => {
    const { counts, serve } = slowCalls(60_000)
    const { door, port, refused } = await made({ token: anyToken, serve, limits: { headersMs: 300, requestMs: 600, keepAliveMs: 300, checkMs: 50 } })
    const held = await hold(door, post(port, ['Authorization: Bearer good']) + 'GARBAGE\r\n\r\n')
    expect(await drained(door, 300)).toBe(1)
    expect(held.raw()).toBe('')
    expect(await drained(door, 1500)).toBe(0)
    expect(held.raw()).toBe('')
    // The count drops before the socket's close, which cancels the call
    await vi.waitFor(() => expect(counts.cancelled).toBe(1))
    expect(counts).toEqual({ made: 1, ended: 0, cancelled: 1 })
    expect(refused).toEqual(['malformed'])
  })
})

describe('times', () => {
  const quick = { headersMs: 300, requestMs: 600, keepAliveMs: 300, checkMs: 50 }

  it('answers 408 and closes when the headers don\'t arrive in time, recorded timeout', async () => {
    const { port, refused } = await made({ limits: quick })
    const { raw, closed, closedAfterMs } = await exchange(port, `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`, 3000)
    const [response] = responses(raw)
    expect(response.status).toBe(408)
    expectOnlyOwnHeaders(response, ['connection'])
    expect(closed).toBe(true)
    expect(closedAfterMs).toBeLessThan(1500)
    expect(refused).toEqual(['timeout'])
  })

  it('answers 408 when the body doesn\'t arrive in time, recorded timeout', async () => {
    const { port, passed, refused } = await made({ token: anyToken, limits: quick })
    const { raw, closed } = await exchange(port, post(port, ['Authorization: Bearer good'], '{}').replace('Content-Length: 2', 'Content-Length: 50'), 3000)
    expect(responses(raw)[0].status).toBe(408)
    expect(closed).toBe(true)
    expect(passed).toEqual([])
    expect(refused).toEqual(['timeout'])
  })

  it('closes an idle kept-alive socket', async () => {
    const { port } = await made({ token: anyToken, limits: quick })
    const { raw, closed, closedAfterMs } = await exchange(port, post(port, ['Authorization: Bearer good']), 3000)
    expect(responses(raw)[0].status).toBe(200)
    expect(closed).toBe(true)
    // Node keeps a second past the time it names in Keep-Alive
    expect(closedAfterMs).toBeLessThan(2500)
  })
})

describe('counts', () => {
  it('answers 100 requests on one socket, the last naming Connection: close, and Node\'s 503 to one more', async () => {
    // A clock a second on for each request, so the rate never answers first
    let now = 0
    const { port, passed } = await made({ token: anyToken, clock: () => (now += 1000) })
    const one = post(port, ['Authorization: Bearer good'])
    const { raw } = await exchange(port, one.repeat(101), 2500)
    const all = responses(raw)
    expect(all.slice(0, 100).every(response => response.status === 200)).toBe(true)
    expect(header(all[99], 'connection')).toBe('close')
    expect(all.slice(100).map(response => response.status)).toEqual([503])
    expect(passed).toHaveLength(100)
  }, 10_000)

  it('holds 64 connections and drops more with no answer', async () => {
    const { port } = await made()
    const held: net.Socket[] = []
    for (let i = 0; i < 64; i++) {
      const socket = net.connect({ host: '127.0.0.1', port })
      sockets.push(socket)
      socket.on('error', () => {})
      await new Promise(resolve => socket.once('connect', resolve))
      held.push(socket)
    }
    await new Promise(resolve => setTimeout(resolve, 200))
    const extra = await exchange(port, post(port), 1000)
    expect(extra.raw).toBe('')
    expect(extra.closed).toBe(true)
    for (const socket of held) socket.destroy()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(responses((await exchange(port, post(port))).raw)[0].status).toBe(401)
  })

  it('answers 429 past 50 requests a second and records rate, counting only requests that passed the checks before it', async () => {
    let now = 0
    const { port, refused, passed } = await made({ token: anyToken, clock: () => now })
    // A page that rebinds a name can't spend the agents' rate
    const foreign = post(port).replace(`Host: 127.0.0.1:${port}`, 'Host: evil.example')
    for (let i = 0; i < 60; i++) await exchange(port, foreign)
    const good = post(port, ['Authorization: Bearer good'])
    const first = responses((await exchange(port, good.repeat(51), 4000)).raw)
    expect(first.map(response => response.status)).toEqual([...Array(50).fill(200), 429])
    expect(refused.filter(reason => reason === 'rate')).toEqual(['rate'])
    expect(passed).toHaveLength(50)
    now = 1000
    expect(responses((await exchange(port, good)).raw)[0].status).toBe(200)
  })
})

// The port is held for the whole run, so the door answers while nothing behind it can serve: 503 with the fixed body
// after the door's own checks and the rate and before the token is looked at, whatever token came
describe('while what serves is away', () => {
  it('answers 503 with the fixed body to any token or none, never asking the seam, recording nothing and closing', async () => {
    const asked: (string | null)[] = []
    const { port, refused, passed } = await made({ token: text => (asked.push(text), anyToken(text)), ready: () => false })
    for (const extra of [['Authorization: Bearer good'], ['Authorization: Bearer bad'], []]) {
      const answered = await exchange(port, post(port, extra))
      const [response] = responses(answered.raw)
      expect(response.status).toBe(503)
      expect(response.body).toBe('{"error":"unavailable"}')
      expect(header(response, 'content-type')).toBe('application/json')
      expectOnlyOwnHeaders(response, ['content-type', 'connection'])
      expect(answered.closed).toBe(true)
    }
    expect(asked).toEqual([])
    expect(passed).toEqual([])
    expect(refused).toEqual([])
  })

  it("refuses at the door's own checks first, each recorded", async () => {
    const { port, refused } = await made({ token: anyToken, ready: () => false })
    const statuses: number[] = []
    for (const text of [
      post(port, ['Authorization: Bearer good']).replace(`Host: 127.0.0.1:${port}`, 'Host: evil.example'),
      post(port, ['Authorization: Bearer good', 'Origin: https://evil.example']),
      request(['GET /mcp HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Authorization: Bearer good']),
      post(port, ['Authorization: Bearer good', 'Expect: something-else']),
      request(['POST /mcp HTTP/1.1', `Host: 127.0.0.1:${port}`, `Content-Length: ${doorLimits.mcpBodyBytes + 1}`, 'Authorization: Bearer good']),
    ]) statuses.push(responses((await exchange(port, text)).raw)[0].status)
    expect(statuses).toEqual([403, 403, 405, 417, 413])
    expect(refused).toEqual(['host', 'origin', 'method', 'malformed', 'size'])
  })

  it('serves again once what serves is back, read at each request', async () => {
    let ready = false
    const { port, passed } = await made({ token: anyToken, ready: () => ready })
    expect(responses((await exchange(port, post(port, ['Authorization: Bearer good']))).raw)[0].status).toBe(503)
    ready = true
    expect(responses((await exchange(port, post(port, ['Authorization: Bearer good', 'Connection: close']))).raw)[0].status).toBe(200)
    ready = false
    expect(responses((await exchange(port, post(port, ['Authorization: Bearer good']))).raw)[0].status).toBe(503)
    expect(passed).toHaveLength(1)
  })

  it('serves nothing pipelined behind a 503 on its socket', async () => {
    const { port, passed } = await made({ token: anyToken, ready: () => false })
    const answered = responses((await exchange(port, post(port, ['Authorization: Bearer good']).repeat(3))).raw)
    expect(answered.map(response => response.status)).toEqual([503])
    expect(passed).toEqual([])
  })
})

// A caller with no token can't shut agents out: a request with no well-formed token spends a bucket of its own and
// never the seam, the agents' bucket counts only a token the seam took, a connection that says nothing is let go and
// one dropped at the cap is recorded
describe('callers with no token', () => {
  // Each request on its own connection, as a flood would send them
  const each = async (port: number, texts: string[]) => {
    const statuses: number[] = []
    for (const text of texts) statuses.push(responses((await exchange(port, text)).raw)[0]?.status ?? 0)
    return statuses
  }
  const silent = async (port: number) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    sockets.push(socket)
    socket.on('error', () => {})
    await new Promise(resolve => socket.once('connect', resolve))
    return socket
  }
  const open = (door: Door) => new Promise<number>(resolve => door.server.getConnections((_err, count) => resolve(count)))

  it('leaves a request with a good token served while 50 a second come with none, which spend a bucket of their own', async () => {
    const asked: (string | null)[] = []
    const { port, refused, passed } = await made({ token: async text => (asked.push(text), anyToken(text)), clock: () => 0 })
    const none = await each(port, Array.from({ length: 50 }, () => post(port)))
    expect(none).toEqual([...Array(10).fill(401), ...Array(40).fill(429)])
    const good = await each(port, Array.from({ length: 50 }, () => post(port, ['Authorization: Bearer good', 'Connection: close'])))
    expect(good).toEqual(Array(50).fill(200))
    expect(asked).toEqual(Array(50).fill('Bearer good'))
    expect(passed).toHaveLength(50)
    expect(refused.filter(reason => reason === 'token')).toHaveLength(10)
    expect(refused.filter(reason => reason === 'rate')).toHaveLength(40)
  })

  it('counts an Authorization that is not one Bearer token of the token grammar as none, never asking the seam', async () => {
    const asked: (string | null)[] = []
    const { port } = await made({ token: async text => (asked.push(text), anyToken(text)), clock: () => 0 })
    const sent = [[], ['Authorization: Basic YTpi'], ['Authorization: bearer good'], ['Authorization: Bearer a b'], ['Authorization: Bearer good', 'Authorization: Bearer good']]
    expect(await each(port, sent.map(extra => post(port, extra)))).toEqual(Array(5).fill(401))
    expect(asked).toEqual([])
  })

  it('leaves a request with a good token served while tokens of the right shape nobody issued flood, each asking the seam once', async () => {
    let asked = 0
    const { port, passed } = await made({ token: async text => (asked++, anyToken(text)), clock: () => 0 })
    const made_up = await each(port, Array.from({ length: 60 }, (_, i) => post(port, [`Authorization: Bearer made-up-${i}`])))
    expect(made_up).toEqual(Array(60).fill(401))
    expect(asked).toBe(60)
    expect(await each(port, Array.from({ length: 51 }, () => post(port, ['Authorization: Bearer good', 'Connection: close'])))).toEqual([...Array(50).fill(200), 429])
    expect(passed).toHaveLength(50)
  })

  it('answers 503 to a well-formed token while what serves is away with no bucket spent and 429 to none past its own', async () => {
    const { port, refused } = await made({ token: anyToken, clock: () => 0, ready: () => false })
    expect(await each(port, Array.from({ length: 60 }, () => post(port, ['Authorization: Bearer good'])))).toEqual(Array(60).fill(503))
    expect(await each(port, Array.from({ length: 11 }, () => post(port)))).toEqual([...Array(10).fill(503), 429])
    expect(refused).toEqual(['rate'])
  })

  it('lets go of a connection that sends nothing within about a second, with the door\'s 408 recorded timeout', async () => {
    const { port, refused } = await made()
    const answered = await exchange(port, '', 3000)
    expect(answered.closed).toBe(true)
    expect(answered.closedAfterMs).toBeGreaterThan(800)
    expect(answered.closedAfterMs).toBeLessThan(1500)
    expect(responses(answered.raw).map(response => response.status)).toEqual([408])
    expect(refused).toEqual(['timeout'])
  })

  it('leaves a connection that sent part of its request to the headers time', async () => {
    const { port, refused } = await made({ limits: { headersMs: 3000 } })
    const answered = await exchange(port, `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`, 2000)
    expect(answered.closed).toBe(false)
    expect(refused).toEqual([])
  })

  it('lets go of 64 connections that say nothing within the bound and then answers a good request', async () => {
    const { door, port, refused } = await made({ token: anyToken })
    // All at once, so none is let go before the last is held
    await Promise.all([accepted(door, 64), ...Array.from({ length: 64 }, () => silent(port))])
    expect(await open(door)).toBe(64)
    await vi.waitFor(async () => expect(await open(door)).toBe(0), { timeout: 1600, interval: 50 })
    expect(refused).toEqual(Array(64).fill('timeout'))
    expect(responses((await exchange(port, post(port, ['Authorization: Bearer good']))).raw)[0].status).toBe(200)
  })

  it('records each connection dropped at the 64 cap as full', async () => {
    const { door, port, refused } = await made({ token: anyToken })
    const held: net.Socket[] = []
    for (let i = 0; i < 64; i++) {
      const socket = await silent(port)
      socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`)
      held.push(socket)
    }
    await vi.waitFor(async () => expect(await open(door)).toBe(64))
    for (let i = 0; i < 3; i++) {
      const extra = await exchange(port, post(port), 1000)
      expect([extra.raw, extra.closed]).toEqual(['', true])
    }
    expect(refused).toEqual(['full', 'full', 'full'])
    for (const socket of held) socket.destroy()
  })
})

describe('a client that goes', () => {
  it('aborts the call it was waiting on', async () => {
    let signal: AbortSignal | null = null
    const { port } = await made({
      token: anyToken,
      serve: call => {
        signal = call.signal
        return new Promise(() => {})
      },
    })
    const socket = net.connect({ host: '127.0.0.1', port })
    sockets.push(socket)
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write(post(port, ['Authorization: Bearer good']))
    await vi.waitFor(() => expect(signal).not.toBe(null))
    expect(signal!.aborted).toBe(false)
    socket.destroy()
    await vi.waitFor(() => expect(signal!.aborted).toBe(true))
  })
})

describe('what the door writes', () => {
  it('writes no line anywhere and records only fixed reasons, never a Host, an Origin, a target, a token or a body', async () => {
    const lines: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')))
    }
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => (lines.push(String(chunk)), true))
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => (lines.push(String(chunk)), true))
    const { port, refused } = await made({ token: anyToken })
    const secrets = ['host-secret.example', 'origin-secret.example', 'query-secret', 'Bearer token-secret', 'body-secret']
    await exchange(port, post(port, [], '{"x":"body-secret"}').replace(`127.0.0.1:${port}`, 'host-secret.example'))
    await exchange(port, post(port, ['Origin: https://origin-secret.example'], '{"x":"body-secret"}'))
    await exchange(port, post(port, ['Authorization: Bearer good'], '{}').replace('POST /mcp', 'POST /mcp?query-secret'))
    await exchange(port, post(port, ['Authorization: Bearer token-secret'], '{"x":"body-secret"}'))
    await exchange(port, post(port, [`X-Pad: ${'host-secret.example'.repeat(500)}`]))
    out.mockRestore()
    err.mockRestore()
    expect(lines).toEqual([])
    expect(refused).toEqual(['host', 'origin', 'method', 'token', 'size'])
    for (const reason of refused) for (const secret of secrets) expect(reason).not.toContain(secret)
  })
})
