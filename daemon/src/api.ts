import type { IncomingMessage, ServerResponse } from 'node:http'
import { VaultError, type Change, type ErrorCode, type VaultCore } from './core.ts'
import { callContext } from './log.ts'

// The editor's adapter over the same core the MCP tools use. Agents lease and write, the editor reads, watches and saves
//
//   GET  /api/notes                 every file with version and lease holder
//   GET  /api/notes/<path>          text, version, lease holder
//   PUT  /api/notes/<path>          { text, baseVersion } -> save and commit
//   GET  /api/files/<path>          raw bytes, for artifacts
//   GET  /api/history/<path>        recent commits
//   GET  /api/events                Server-Sent Events: leases and note changes as they happen

const STATUS: Record<ErrorCode, number> = {
  NotFound: 404,
  OutsideVault: 400,
  StaleVersion: 409,
  LeaseHeld: 423,
  LeaseNotFound: 400,
  OutOfScope: 400,
  NotUnique: 400,
  TextNotFound: 400,
}

const MAX_BODY = 4 * 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'body is not JSON')
  }
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Each connected editor gets every change. A heartbeat comment keeps proxies from closing an idle stream
function events(core: VaultCore, req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  // The current leases first, so an editor that connects or reconnects mid-lease locks the right notes
  res.write('retry: 2000\n\n')
  send('hello', { leases: core.leaseViews() })
  const unsubscribe = core.subscribe((change: Change) => send(change.type, change))
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
  core.events.emit('api.stream_opened')
  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
    callContext.run({ source: 'api' }, () => core.events.emit('api.stream_closed'))
  })
}

async function route(core: VaultCore, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<number> {
  const method = req.method ?? 'GET'
  if (pathname === '/api/events' && method === 'GET') {
    events(core, req, res)
    return 200
  }
  if (pathname === '/api/notes' && method === 'GET') {
    json(res, 200, await core.listNotes())
    return 200
  }
  const match = /^\/api\/(notes|files|history)\/(.+)$/.exec(pathname)
  if (!match) throw new HttpError(404, 'no such route')
  const [, kind, encoded] = match
  let file: string
  try {
    file = decodeURIComponent(encoded)
  } catch {
    throw new HttpError(400, 'bad path encoding')
  }

  if (kind === 'notes' && method === 'GET') {
    json(res, 200, await core.readNote(file))
    return 200
  }
  if (kind === 'notes' && method === 'PUT') {
    const body = (await readJson(req)) as { text?: unknown; baseVersion?: unknown }
    if (typeof body.text !== 'string' || (typeof body.baseVersion !== 'string' && body.baseVersion !== null)) {
      throw new HttpError(400, 'expected { text: string, baseVersion: string | null }')
    }
    json(res, 200, await core.humanSave(file, body.text, body.baseVersion))
    return 200
  }
  if (kind === 'files' && method === 'GET') {
    const { bytes, version } = await core.readRaw(file)
    // Served as inert text even for .html: the editor puts artifacts in a sandboxed srcdoc frame itself. If this URL
    // is ever opened directly, the browser must not run it on the editor's origin
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'no-store',
      etag: `"${version}"`,
    })
    res.end(bytes)
    return 200
  }
  if (kind === 'history' && method === 'GET') {
    json(res, 200, await core.history(file, 20))
    return 200
  }
  throw new HttpError(405, 'method not allowed')
}

export async function handleApi(core: VaultCore, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const parent = callContext.getStore() ?? {}
  await callContext.run({ ...parent, source: 'api' }, async () => {
    const started = performance.now()
    const route_ = `${req.method} ${pathname.replace(/^(\/api\/(?:notes|files|history))\/.+$/, '$1/*')}`
    const file = /^\/api\/(?:notes|files|history)\/(.+)$/.exec(pathname)?.[1]
    const log = (fields: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info') =>
      core.events.emit('api.call', { route: route_, path: file ? safeDecode(file) : undefined, ...fields, ms: Math.round(performance.now() - started) }, level)
    try {
      const status = await route(core, req, res, pathname)
      if (pathname !== '/api/events') log({ status, outcome: 'success' })
    } catch (err) {
      if (err instanceof VaultError) {
        const status = STATUS[err.code]
        log({ status, outcome: 'failure', error: err.code }, err.code === 'OutsideVault' ? 'warn' : 'info')
        json(res, status, { error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) })
      } else if (err instanceof HttpError) {
        log({ status: err.status, outcome: 'failure', error: err.message }, 'warn')
        json(res, err.status, { error: err.message })
      } else {
        log({ status: 500, outcome: 'error', error: String(err) }, 'error')
        if (!res.headersSent) json(res, 500, { error: 'internal error' })
      }
    }
  })
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
