import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import {
  authorizationOf, checkDoor, doorLimits, HOST, type Refusal, type RefusalReason, type Seen, type TokenSeam,
} from './checks.ts'

// The door: Node's own HTTP/1.1 server on 127.0.0.1 and one port, every request through the checks of checks.ts in
// their order, then the rate, the size, whether what serves is there, the token, which settles later, and only then the
// body. Nothing a request sent reaches a response header and nothing is written to any log or console. A refusal is
// told by its fixed reason alone

// What serving a request that passed every check answers. Only these two fields are read
export type Answer = { status: number, body: string | null }

// A request that passed every check: the client the token named, the body as bytes and the raw header list with no
// Authorization in it. signal aborts when the client goes before the answer
export type Passed = { client: string, body: Buffer, headers: readonly string[], signal: AbortSignal }

// The times a test may shorten, with how often Node checks them
export type DoorTimes = { headersMs: number, requestMs: number, keepAliveMs: number, checkMs: number }

export type DoorOptions = {
  port: number
  token: TokenSeam
  // An answer is passed on with its status and body. A refusal is the door's: recorded by its reason, answered with
  // no body and the connection closed
  serve: (passed: Passed) => Promise<Answer | Refusal>
  refused: (reason: RefusalReason) => void
  // Whether what serves a request that passed is there, read at each request. While it isn't the door answers 503
  // with the fixed body before the token is looked at, nothing recorded. Left out, it is always there
  ready?: () => boolean
  limits?: Partial<DoorTimes>
  clock?: () => number
}

// What Node's parser is built with: the strict parser, the header limit and a missing Host left to the door's own check
export type Parser = { maxHeaderSize: number, insecureHTTPParser: false, requireHostHeader: false }

export type Door = { address: AddressInfo, server: http.Server, parser: Parser, close(): Promise<void> }

// The headers every response carries. Nothing else is set but the length, a JSON body's type and the few a status names
const FIXED: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': 'default-src \'none\'; frame-ancestors \'none\'',
})

// What the door answers while nothing serves behind it, the body the serving part gives a refused call
export const UNAVAILABLE = '{"error":"unavailable"}'

// The headers a refusal adds to the fixed ones. The 401 names where the resource's metadata is, on the door's own port
// (RFC 9728), the only text in a header the door builds and never from the request
function added(status: number, port: number): Readonly<Record<string, string>> {
  if (status === 401) return { 'WWW-Authenticate': `Bearer resource_metadata="http://${HOST}:${port}/.well-known/oauth-protected-resource/mcp"` }
  if (status === 405) return { Allow: 'POST' }
  return {}
}

// The raw header list with every Authorization header taken out, so nothing behind the door can pass a token on
function withoutAuthorization(raw: readonly string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i].toLowerCase() !== 'authorization') kept.push(raw[i], raw[i + 1])
  return kept
}

// A status line and the fixed headers for an answer written straight to the socket, when Node's parser refused the
// request before it was one
function rawAnswer(status: number, extra: Readonly<Record<string, string>> = {}): string {
  const lines = [`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}`]
  for (const [name, value] of Object.entries({ ...FIXED, ...extra })) lines.push(`${name}: ${value}`)
  lines.push(`Date: ${new Date().toUTCString()}`, 'Content-Length: 0', 'Connection: close')
  return `${lines.join('\r\n')}\r\n\r\n`
}

// Requests in the last second, oldest first. A request counts only once it passed the checks before the rate, so a
// page on another name can't spend what the agents have
function rate(perSecond: number, clock: () => number): () => boolean {
  const times: number[] = []
  return () => {
    const now = clock()
    while (times.length > 0 && now - times[0] >= 1000) times.shift()
    if (times.length >= perSecond) return false
    times.push(now)
    return true
  }
}

// Opens the door on 127.0.0.1 and the port given, or rejects. A port that is taken is never traded for another, since
// every URL a harness keeps names this one
export function openDoor(options: DoorOptions): Promise<Door> {
  const times: DoorTimes = { headersMs: doorLimits.headersMs, requestMs: doorLimits.requestMs, keepAliveMs: doorLimits.keepAliveMs, checkMs: 1000, ...options.limits }
  const take = rate(doorLimits.perSecond, options.clock ?? (() => performance.now()))
  const parser: Parser = { maxHeaderSize: doorLimits.headerBytes, insecureHTTPParser: false, requireHostHeader: false }
  // The port the Host must name, the one bound when a test asked for any
  let bound = options.port
  // The response in progress on each socket, so a parser error after its headers went out ends the socket unanswered
  const current = new WeakMap<Socket, http.ServerResponse>()
  // The sockets Node's parser already refused, each recorded once
  const told = new WeakSet<Socket>()
  // Each request's place on its socket and the place of the first one refused there. A request Node read behind a
  // refused one is never checked or served, one ahead of it still is
  const placed = new WeakMap<http.IncomingMessage, number>()
  const counted = new WeakMap<Socket, number>()
  const shut = new WeakMap<Socket, number>()
  const behindRefusal = (req: http.IncomingMessage) => (shut.get(req.socket) ?? Infinity) < (placed.get(req) ?? 0)
  // The calls each socket carries, all cancelled when it closes, a response still queued behind another included
  const carried = new WeakMap<Socket, Set<AbortController>>()
  const callsOn = (socket: Socket) => {
    let calls = carried.get(socket)
    if (calls === undefined) {
      const made = new Set<AbortController>()
      calls = made
      carried.set(socket, made)
      socket.once('close', () => {
        for (const call of made) call.abort()
      })
    }
    return calls
  }

  // The answers each socket still owes, those Node holds in line behind another included
  const owing = new WeakMap<Socket, Set<http.ServerResponse>>()
  // The raw answer a socket keeps until every answer it owes went out and the sockets already given one
  const waiting = new WeakMap<Socket, string>()
  const ending = new WeakSet<Socket>()
  const owe = (socket: Socket, res: http.ServerResponse) => {
    const owed = owing.get(socket) ?? new Set<http.ServerResponse>()
    owing.set(socket, owed)
    owed.add(res)
    res.once('close', () => {
      owed.delete(res)
      flush(socket)
    })
  }
  // Only a request read to its end is ahead of a refusal. One still being read is the request a parser failure or a
  // timeout is about, so its answer is the raw one
  const owesAhead = (socket: Socket) => [...owing.get(socket) ?? []].some(res => res.req.complete)
  const flush = (socket: Socket) => {
    const text = waiting.get(socket)
    if (text === undefined || owesAhead(socket)) return
    waiting.delete(socket)
    if (!socket.writable) return void socket.destroy()
    socket.end(text, () => socket.destroy())
  }

  // A raw answer ends the socket. It goes out only after every answer the socket owes, so a client never reads it as
  // the answer to a request it sent before, then the door's end and the socket destroyed once it is flushed. At the
  // latest the socket is destroyed the request time after the refusal, whatever the client does, a call still owed
  // cancelled with it. end alone would keep the socket until the client's own end
  const endRaw = (socket: Socket, text: string) => {
    if (ending.has(socket)) return
    ending.add(socket)
    const cap = setTimeout(() => socket.destroy(), times.requestMs)
    socket.once('close', () => clearTimeout(cap))
    waiting.set(socket, text)
    flush(socket)
  }

  const answer = (res: http.ServerResponse, status: number, body: string | null, close: boolean, extra: Readonly<Record<string, string>> = {}) => {
    const text = body ?? ''
    const headers: Record<string, string> = { ...FIXED, ...extra, 'Content-Length': String(Buffer.byteLength(text)) }
    if (body !== null) headers['Content-Type'] = 'application/json'
    if (close) headers.Connection = 'close'
    res.writeHead(status, headers)
    res.end(text)
  }

  // Nothing Node read behind this request on its socket is served
  const shutBehind = (req: http.IncomingMessage) => shut.set(req.socket, Math.min(shut.get(req.socket) ?? Infinity, placed.get(req) ?? 0))

  // A refusal is recorded by its reason, answered with no body and ends the connection, so nothing it sent after is read
  const refuse = (req: http.IncomingMessage, res: http.ServerResponse, refusal: Refusal) => {
    shutBehind(req)
    options.refused(refusal.reason)
    answer(res, refusal.status, null, true, added(refusal.status, bound))
  }

  // Nothing serves behind the door: the fixed 503, unrecorded, since the request did nothing wrong, and the connection
  // ended, since its body was never read
  const away = (req: http.IncomingMessage, res: http.ServerResponse) => {
    shutBehind(req)
    answer(res, 503, UNAVAILABLE, true)
  }

  // expects is the Expect header Node met: none, 100-continue or another, which the door answers 417 once the checks
  // before it passed
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse, expects: 'none' | 'continue' | 'other') => {
    const place = (counted.get(req.socket) ?? 0) + 1
    counted.set(req.socket, place)
    placed.set(req, place)
    if (behindRefusal(req)) return
    owe(req.socket, res)
    current.set(req.socket, res)
    const seen: Seen = { method: req.method ?? '', target: req.url ?? '', version: req.httpVersion, headers: req.rawHeaders }
    const checked = checkDoor(seen, bound)
    if ('status' in checked) return refuse(req, res, checked)
    if (expects === 'other') return refuse(req, res, { status: 417, reason: 'malformed' })
    if (!take()) return refuse(req, res, { status: 429, reason: 'rate' })
    const declared = req.headers['content-length']
    if (declared !== undefined && Number(declared) > doorLimits.mcpBodyBytes) return refuse(req, res, { status: 413, reason: 'size' })
    if (options.ready?.() === false) return away(req, res)
    // A check that throws names no client
    const client = await options.token(authorizationOf(seen)).catch(() => null)
    // The socket may have been refused or closed while the check ran, so nothing more is written or read for it
    if (behindRefusal(req) || req.socket.destroyed) return
    if (client === null) return refuse(req, res, { status: 401, reason: 'token' })
    if (expects === 'continue') res.writeContinue()
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    await new Promise<void>(resolve => {
      req.on('data', (chunk: Buffer) => {
        if (over) return
        size += chunk.length
        if (size > doorLimits.mcpBodyBytes) {
          over = true
          chunks.length = 0
          resolve()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve())
      req.on('error', () => resolve())
      req.on('close', () => resolve())
    })
    if (over) {
      refuse(req, res, { status: 413, reason: 'size' })
      req.socket.destroySoon()
      return
    }
    if (!req.complete || behindRefusal(req) || req.socket.destroyed) return
    const gone = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) gone.abort()
    })
    const calls = callsOn(req.socket)
    calls.add(gone)
    let given: Answer | Refusal
    try {
      given = await options.serve({ client: client.client, body: Buffer.concat(chunks), headers: withoutAuthorization(req.rawHeaders), signal: gone.signal })
    } catch {
      return answer(res, 502, null, true)
    } finally {
      calls.delete(gone)
    }
    if (res.destroyed) return
    if ('reason' in given) return refuse(req, res, given)
    try {
      answer(res, given.status, given.body, false)
    } catch {
      if (!res.headersSent) answer(res, 502, null, true)
    }
  }

  const server = http.createServer({
    ...parser,
    headersTimeout: times.headersMs,
    requestTimeout: times.requestMs,
    keepAliveTimeout: times.keepAliveMs,
    connectionsCheckingInterval: times.checkMs,
    joinDuplicateHeaders: false,
  }, (req, res) => void handle(req, res, 'none'))
  server.on('checkContinue', (req, res) => void handle(req, res, 'continue'))
  server.on('checkExpectation', (req, res) => void handle(req, res, 'other'))
  // A CONNECT is never taken. It meets the checks, so a wrong Host or target is refused for that, and is refused with
  // the door's own answer, recorded, where Node would cut it unanswered
  server.on('connect', (req: http.IncomingMessage, socket: Socket) => {
    socket.on('error', () => {})
    const seen: Seen = { method: req.method ?? '', target: req.url ?? '', version: req.httpVersion, headers: req.rawHeaders }
    const checked = checkDoor(seen, bound)
    const refusal: Refusal = 'status' in checked ? checked : { status: 405, reason: 'method', allow: 'POST' }
    options.refused(refusal.reason)
    endRaw(socket, rawAnswer(refusal.status, added(refusal.status, bound)))
  })
  server.keepAliveTimeout = times.keepAliveMs
  server.maxRequestsPerSocket = doorLimits.requestsPerSocket
  server.maxConnections = doorLimits.connections

  // Node's parser refused the request or its time ran out. The answer carries the fixed headers and closes. Headers past
  // the limit count as size, other bytes the parser refused as malformed and a request too slow as timeout, once a
  // socket, since the parser may fail again on what a refused socket still holds. A socket error is no refusal and goes
  // unrecorded
  server.on('clientError', (err: NodeJS.ErrnoException, socket: Socket) => {
    if (!told.has(socket)) {
      told.add(socket)
      if (err.code === 'HPE_HEADER_OVERFLOW') options.refused('size')
      else if (err.code === 'ERR_HTTP_REQUEST_TIMEOUT') options.refused('timeout')
      else if (err.code?.startsWith('HPE_') === true) options.refused('malformed')
    }
    const res = current.get(socket)
    if (err.code === 'ECONNRESET' || !socket.writable || (res !== undefined && res.headersSent && !res.writableFinished)) {
      socket.destroy()
      return
    }
    const status = err.code === 'HPE_HEADER_OVERFLOW' ? 431 : err.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400
    endRaw(socket, rawAnswer(status))
  })

  return new Promise((resolve, reject) => {
    const failed = (err: Error) => reject(err)
    server.once('error', failed)
    server.listen({ host: HOST, port: options.port, exclusive: true }, () => {
      server.off('error', failed)
      const address = server.address() as AddressInfo
      bound = address.port
      resolve({
        address,
        server,
        parser,
        close: () => new Promise<void>(done => {
          server.close(() => done())
          server.closeAllConnections()
        }),
      })
    })
  })
}
